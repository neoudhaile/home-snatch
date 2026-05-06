/**
 * AI insights for the admin dashboard.
 *
 * Three pure server-side functions:
 *   - generateMarketSummary: deterministic stats + Sonnet 4.6 commentary
 *   - detectAnomalies: deterministic flags only, no LLM
 *   - recommendCleanup: deterministic candidate selection + single LLM batch
 *     for one-line rationales
 *
 * All three are read-only with respect to the DB. Cleanup *suggestions* are
 * surfaced; the actual `is_active=false` write happens in the admin POST
 * handler after a user click.
 *
 * Voice rules (PRODUCT.md): NYC-direct, numbers over adjectives, no real-estate
 * adjectives, no em dashes. We sanitize LLM output post-hoc as defense in depth.
 */
import { differenceInDays } from 'date-fns'
import { eq, sql } from 'drizzle-orm'
import { listings as listingsTable, scores as scoresTable } from '@/db/schema'
import { getDb } from '@/lib/db'
import { getRankedFeed } from '@/lib/listing-helpers'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import type { Listing, RankedListing } from '@/types'

// ---------- types ----------

export type BoroughStat = {
  borough: string
  count: number
  median: number | null
  p25: number | null
  p75: number | null
}

export type MoverStat = {
  listing_id: string
  title: string
  neighborhood: string | null
  borough: string | null
  price: number | null
  source: string
  posted_days_ago: number | null
  source_url: string
}

export type RawMarketStats = {
  window_days: number
  total_listings: number
  by_borough: BoroughStat[]
  top_neighborhoods: { neighborhood: string; borough: string | null; count: number; median: number | null }[]
  by_source: { source: string; count: number }[]
  freshest: MoverStat[]
  cheapest_under_3k: MoverStat[]
}

export type MarketSummary = {
  headline: string
  three_observations: string[]
  one_recommendation: string
  computed_at: Date
  raw_stats: RawMarketStats
  /** True if the LLM was skipped (no key) and we returned a deterministic fallback. */
  llm_skipped?: boolean
}

export type AnomalyType =
  | 'price_outlier'
  | 'no_contact'
  | 'stale_data'
  | 'suspicious_dupe'
  | 'missing_address'

export type AnomalySeverity = 'info' | 'warn' | 'danger'

export type Anomaly = {
  listing_id: string
  listing_title: string
  source_url: string
  type: AnomalyType
  severity: AnomalySeverity
  detail: string
}

export type CleanupAction = 'deactivate' | 'delete' | 'mark-low-quality'

export type CleanupSuggestion = {
  listing_id: string
  action: CleanupAction
  reason: string
  listing_summary: string
  source_url: string
}

// ---------- voice-rule lint ----------

const BANNED_WORDS = [
  'luxury',
  'modern',
  'stunning',
  'must-see',
  'charming',
  'cozy',
  'seamless',
  'robust',
  'elevated',
  'delightful',
  'vibrant',
] as const

/**
 * Strip em dashes + scrub banned words. Replaces banned words with a neutral
 * placeholder so we don't silently emit voice violations. The LLM is
 * instructed to avoid these; this is post-hoc enforcement.
 */
export function lintVoice(text: string): string {
  let out = text.replaceAll('—', ', ').replaceAll('–', '-').trim()
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'gi')
    out = out.replace(re, '[redacted]')
  }
  return out
}

// ---------- shared helpers ----------

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))))
  return sorted[idx]
}

function postedDaysAgo(d: Date | null | undefined): number | null {
  if (!d) return null
  return Math.max(0, differenceInDays(new Date(), d))
}

function toMover(l: Pick<Listing, 'id' | 'title' | 'neighborhood' | 'borough' | 'price_monthly' | 'source' | 'posted_at' | 'source_url'>): MoverStat {
  return {
    listing_id: l.id,
    title: l.title,
    neighborhood: l.neighborhood ?? null,
    borough: l.borough ?? null,
    price: l.price_monthly ?? null,
    source: l.source,
    posted_days_ago: postedDaysAgo(l.posted_at ?? null),
    source_url: l.source_url,
  }
}

// ---------- 1. market summary ----------

const MARKET_SYSTEM_PROMPT = `You are summarizing the NYC rental market for two roommates apartment-hunting. Be NYC-direct, numbers over adjectives. No real-estate prose. Three observations should be specific and actionable. The recommendation should suggest one concrete thing they should do this week (e.g. 'Tour the top 3 in Bed-Stuy this Saturday, that pocket has 4 fresh listings under $3k', or 'Skip Williamsburg this week, median is $4,800, none under your stretch budget').

Hard rules:
- Every observation must cite a specific number AND name a neighborhood, borough, or source.
- The headline must reference at least one specific number (a count, a median, a percentage).
- The recommendation must be actionable: name a neighborhood plus a count or a date range.
- Banned words: luxury, modern, stunning, must-see, charming, cozy, seamless, robust, elevated, delightful, vibrant.
- No em dashes. Use periods or commas.
- Do not invent numbers. Only use what is in the provided stats block.
- Do not write generic copy like "Brooklyn is hot" or "good time to look". Always specific.

Call the emit_summary tool exactly once with your final answer.`

const SUMMARY_TOOL = {
  name: 'emit_summary',
  description: 'Emit the headline, three observations, and one recommendation.',
  input_schema: {
    type: 'object' as const,
    properties: {
      headline: {
        type: 'string' as const,
        maxLength: 220,
        description: 'One line, includes at least one specific number from the stats block.',
      },
      three_observations: {
        type: 'array' as const,
        minItems: 3,
        maxItems: 3,
        items: { type: 'string' as const, maxLength: 240 },
        description: 'Exactly three observations. Each must cite a number AND a neighborhood, borough, or source.',
      },
      one_recommendation: {
        type: 'string' as const,
        maxLength: 240,
        description: 'One actionable recommendation. Names a neighborhood plus a count or date range.',
      },
    },
    required: ['headline', 'three_observations', 'one_recommendation'],
  },
}

/**
 * Compute the deterministic stats block from a list of recent listings.
 * Returned shape is what we ship to the LLM AND surface in the UI for
 * verification.
 */
export function computeRawMarketStats(listings: RankedListing[], windowDays: number): RawMarketStats {
  const total = listings.length

  // by borough
  const byBoroughMap = new Map<string, number[]>()
  for (const l of listings) {
    const b = (l.borough ?? 'unknown').trim() || 'unknown'
    if (l.price_monthly == null) continue
    if (!byBoroughMap.has(b)) byBoroughMap.set(b, [])
    byBoroughMap.get(b)!.push(l.price_monthly)
  }
  const by_borough: BoroughStat[] = []
  for (const [borough, prices] of byBoroughMap.entries()) {
    by_borough.push({
      borough,
      count: prices.length,
      median: median(prices),
      p25: percentile(prices, 0.25),
      p75: percentile(prices, 0.75),
    })
  }
  by_borough.sort((a, b) => b.count - a.count)

  // top neighborhoods
  const nbhdMap = new Map<string, { borough: string | null; prices: number[] }>()
  for (const l of listings) {
    const n = (l.neighborhood ?? '').trim()
    if (!n) continue
    if (!nbhdMap.has(n)) nbhdMap.set(n, { borough: l.borough ?? null, prices: [] })
    if (l.price_monthly != null) nbhdMap.get(n)!.prices.push(l.price_monthly)
  }
  const top_neighborhoods = Array.from(nbhdMap.entries())
    .map(([neighborhood, v]) => ({
      neighborhood,
      borough: v.borough,
      count: v.prices.length,
      median: median(v.prices),
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8)

  // by source
  const srcMap = new Map<string, number>()
  for (const l of listings) {
    srcMap.set(l.source, (srcMap.get(l.source) ?? 0) + 1)
  }
  const by_source = Array.from(srcMap.entries())
    .map(([source, count]) => ({ source, count }))
    .sort((a, b) => b.count - a.count)

  // freshest (newest posted_at, top 5)
  const withPosted = listings.filter((l) => l.posted_at != null)
  withPosted.sort(
    (a, b) => (b.posted_at?.getTime() ?? 0) - (a.posted_at?.getTime() ?? 0)
  )
  const freshest = withPosted.slice(0, 5).map(toMover)

  // cheapest under 3k
  const cheap = listings
    .filter((l) => l.price_monthly != null && l.price_monthly < 3000)
    .sort((a, b) => (a.price_monthly ?? 0) - (b.price_monthly ?? 0))
    .slice(0, 5)
    .map(toMover)

  return {
    window_days: windowDays,
    total_listings: total,
    by_borough,
    top_neighborhoods,
    by_source,
    freshest,
    cheapest_under_3k: cheap,
  }
}

function fallbackSummary(stats: RawMarketStats): { headline: string; three_observations: string[]; one_recommendation: string } {
  // Deterministic fallback used when ANTHROPIC_API_KEY is missing. Stays voice-clean.
  const totalBorough = stats.by_borough[0]
  const topN = stats.top_neighborhoods[0]
  const topSrc = stats.by_source[0]
  const obs1 = totalBorough
    ? `${totalBorough.borough} leads with ${totalBorough.count} listings, median $${totalBorough.median?.toLocaleString('en-US') ?? 'unknown'}.`
    : `${stats.total_listings} listings in window.`
  const obs2 = topN
    ? `${topN.neighborhood} (${topN.borough ?? 'unknown'}) had ${topN.count} listings, median $${topN.median?.toLocaleString('en-US') ?? 'unknown'}.`
    : 'No neighborhood concentration above 1.'
  const obs3 = topSrc
    ? `${topSrc.source} contributed ${topSrc.count} listings, ${Math.round((topSrc.count / Math.max(1, stats.total_listings)) * 100)}% of the window.`
    : 'No source dominates.'
  const rec = topN
    ? `Tour ${topN.neighborhood} this week, ${topN.count} candidates available.`
    : 'Widen the freshness window or add a source to get more signal.'
  return {
    headline: `${stats.total_listings} listings in last ${stats.window_days} days across ${stats.by_borough.length} boroughs.`,
    three_observations: [obs1, obs2, obs3],
    one_recommendation: rec,
  }
}

export async function generateMarketSummary(): Promise<MarketSummary> {
  // Pull listings. getRankedFeed is fallback-safe (mocks if DB unset/empty).
  // Wrap defensively — a feed query throwing here used to take the entire
  // /admin page to 500; now it falls through to the deterministic fallback.
  let listings: RankedListing[] = []
  try {
    listings = await getRankedFeed({ freshness_days: 14, limit: 500 })
  } catch (err) {
    console.warn(`[insights] getRankedFeed failed: ${(err as Error).message}`)
    listings = []
  }
  const stats = computeRawMarketStats(listings, 14)
  const computed_at = new Date()

  // No key → deterministic fallback. UI still gets a usable summary.
  // Empty listings → also skip the LLM call. Sonnet has nothing to summarize
  // and stalls trying. Same fallback works.
  if (!process.env.ANTHROPIC_API_KEY || listings.length === 0) {
    const fb = fallbackSummary(stats)
    return {
      headline: lintVoice(fb.headline),
      three_observations: fb.three_observations.map(lintVoice),
      one_recommendation: lintVoice(fb.one_recommendation),
      computed_at,
      raw_stats: stats,
      llm_skipped: true,
    }
  }

  try {
    const client = getAnthropic()
    const response = await client.messages.create({
      model: MODELS.summarize,
      max_tokens: 1024,
      temperature: 0.3,
      system: [
        {
          // Cache breakpoint: MARKET_SYSTEM_PROMPT is constant across calls,
          // dynamic stats payload lives in the user message strictly after.
          // Expected cache-read hit rate >95% after first call within the
          // 5-min ephemeral window.
          type: 'text',
          text: MARKET_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [SUMMARY_TOOL],
      tool_choice: { type: 'tool', name: 'emit_summary' },
      messages: [
        {
          role: 'user',
          content: `Summarize the NYC rental market for the last ${stats.window_days} days. Stats:\n\n${JSON.stringify(stats, null, 2)}`,
        },
      ],
    })

    const toolBlock = response.content.find((b) => b.type === 'tool_use')
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      throw new Error('no tool_use block in market summary response')
    }

    const out = toolBlock.input as {
      headline: string
      three_observations: string[]
      one_recommendation: string
    }

    if (
      typeof out.headline !== 'string' ||
      !Array.isArray(out.three_observations) ||
      out.three_observations.length !== 3 ||
      typeof out.one_recommendation !== 'string'
    ) {
      throw new Error('malformed tool output for market summary')
    }

    return {
      headline: lintVoice(out.headline),
      three_observations: out.three_observations.map(lintVoice),
      one_recommendation: lintVoice(out.one_recommendation),
      computed_at,
      raw_stats: stats,
    }
  } catch (err) {
    console.warn(`[insights] market summary LLM call failed: ${(err as Error).message}`)
    const fb = fallbackSummary(stats)
    return {
      headline: lintVoice(fb.headline),
      three_observations: fb.three_observations.map(lintVoice),
      one_recommendation: lintVoice(fb.one_recommendation),
      computed_at,
      raw_stats: stats,
      llm_skipped: true,
    }
  }
}

// ---------- 2. anomaly detection ----------

const PRICE_OUTLIER_PCT = 0.25 // listing must be >25% below bucket median
const STALE_DAYS = 10

const SEVERITY_RANK: Record<AnomalySeverity, number> = { danger: 0, warn: 1, info: 2 }

type ActiveListingForAnomaly = Pick<
  Listing,
  | 'id'
  | 'title'
  | 'source'
  | 'source_url'
  | 'price_monthly'
  | 'beds'
  | 'neighborhood'
  | 'photos'
  | 'contact'
  | 'address'
  | 'posted_at'
  | 'last_seen_at'
  | 'fetched_at'
>

function bucketKey(beds: string | null, neighborhood: string | null): string | null {
  if (!neighborhood) return null
  return `${beds ?? 'na'}::${neighborhood.trim().toLowerCase()}`
}

/** Photo URL overlap heuristic for cross-source duplicate detection. */
function photoOverlapKey(photos: string[] | null | undefined): string | null {
  if (!photos || photos.length === 0) return null
  // first photo's path component, lowercased. works for unsplash + most CDNs
  const first = photos[0]
  try {
    const u = new URL(first)
    return `${u.host}${u.pathname.split('?')[0].toLowerCase()}`
  } catch {
    return first.toLowerCase()
  }
}

export async function detectAnomalies(): Promise<Anomaly[]> {
  let rows: ActiveListingForAnomaly[] = []
  try {
    const db = getDb()
    rows = (await db
      .select({
        id: listingsTable.id,
        title: listingsTable.title,
        source: listingsTable.source,
        source_url: listingsTable.source_url,
        price_monthly: listingsTable.price_monthly,
        beds: listingsTable.beds,
        neighborhood: listingsTable.neighborhood,
        photos: listingsTable.photos,
        contact: listingsTable.contact,
        address: listingsTable.address,
        posted_at: listingsTable.posted_at,
        last_seen_at: listingsTable.last_seen_at,
        fetched_at: listingsTable.fetched_at,
      })
      .from(listingsTable)
      .where(eq(listingsTable.is_active, true))) as ActiveListingForAnomaly[]
  } catch (err) {
    // DB unavailable. Return empty rather than crash; UI shows healthy state.
    console.warn(`[insights] detectAnomalies DB read failed: ${(err as Error).message}`)
    return []
  }

  // Build (beds, neighborhood) -> price array.
  const buckets = new Map<string, number[]>()
  for (const l of rows) {
    if (l.price_monthly == null) continue
    const k = bucketKey(l.beds, l.neighborhood)
    if (!k) continue
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(l.price_monthly)
  }
  const bucketMedians = new Map<string, number>()
  for (const [k, prices] of buckets.entries()) {
    if (prices.length < 4) continue // need a real bucket before flagging outliers
    const m = median(prices)
    if (m != null) bucketMedians.set(k, m)
  }

  // Most recent score row per listing (for stale_data check). One round trip.
  let latestScoreByListing = new Map<string, Date>()
  try {
    const db = getDb()
    const scoreRows = (await db
      .select({
        listing_id: scoresTable.listing_id,
        computed_at: sql<Date>`MAX(${scoresTable.computed_at})`,
      })
      .from(scoresTable)
      .groupBy(scoresTable.listing_id)) as Array<{ listing_id: string; computed_at: Date }>
    latestScoreByListing = new Map(scoreRows.map((r) => [r.listing_id, r.computed_at]))
  } catch (err) {
    console.warn(`[insights] detectAnomalies score read failed: ${(err as Error).message}`)
  }

  // Photo-overlap groups for suspicious_dupe.
  const photoGroups = new Map<string, ActiveListingForAnomaly[]>()
  for (const l of rows) {
    const key = photoOverlapKey(l.photos)
    if (!key) continue
    if (!photoGroups.has(key)) photoGroups.set(key, [])
    photoGroups.get(key)!.push(l)
  }
  const dupeIds = new Set<string>()
  for (const [, group] of photoGroups.entries()) {
    if (group.length < 2) continue
    const sources = new Set(group.map((g) => g.source))
    if (sources.size < 2) continue
    for (const g of group) dupeIds.add(g.id)
  }

  const out: Anomaly[] = []
  for (const l of rows) {
    // price_outlier
    if (l.price_monthly != null) {
      const k = bucketKey(l.beds, l.neighborhood)
      if (k) {
        const m = bucketMedians.get(k)
        if (m != null && l.price_monthly < m * (1 - PRICE_OUTLIER_PCT)) {
          const pct = Math.round((1 - l.price_monthly / m) * 100)
          out.push({
            listing_id: l.id,
            listing_title: l.title,
            source_url: l.source_url,
            type: 'price_outlier',
            severity: 'warn',
            detail: `$${l.price_monthly.toLocaleString('en-US')} is ${pct}% below the ${l.beds ?? 'na'}br median in ${l.neighborhood} ($${Math.round(m).toLocaleString('en-US')}). Could be a typo or a deal.`,
          })
        }
      }
    }

    // no_contact (has photos but no contact)
    const photosCount = (l.photos ?? []).length
    const hasContact = !!l.contact && Object.keys(l.contact).length > 0
    if (photosCount > 0 && !hasContact) {
      out.push({
        listing_id: l.id,
        listing_title: l.title,
        source_url: l.source_url,
        type: 'no_contact',
        severity: 'warn',
        detail: `${photosCount} photo(s) but no contact info. Extraction gap.`,
      })
    }

    // stale_data (posted >10d, no rescore since posted)
    const days = postedDaysAgo(l.posted_at ?? null)
    if (days != null && days > STALE_DAYS) {
      const lastScore = latestScoreByListing.get(l.id)
      if (!lastScore || (l.posted_at && lastScore.getTime() < l.posted_at.getTime())) {
        out.push({
          listing_id: l.id,
          listing_title: l.title,
          source_url: l.source_url,
          type: 'stale_data',
          severity: 'info',
          detail: `Posted ${days}d ago, no rescore since posted. Run rescore to refresh rationale.`,
        })
      }
    }

    // suspicious_dupe
    if (dupeIds.has(l.id)) {
      out.push({
        listing_id: l.id,
        listing_title: l.title,
        source_url: l.source_url,
        type: 'suspicious_dupe',
        severity: 'danger',
        detail: `Photo URL matches another active listing on a different source. Likely cross-posted, no canonical_id link.`,
      })
    }

    // missing_address
    if (!l.address || l.address.trim() === '') {
      out.push({
        listing_id: l.id,
        listing_title: l.title,
        source_url: l.source_url,
        type: 'missing_address',
        severity: 'info',
        detail: `No address on file. Commute estimate uses neighborhood centroid only.`,
      })
    }
  }

  out.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
  return out
}

// ---------- 3. cleanup recommendations ----------

const LOW_QUALITY_SCORE_CUTOFF = 30

const CLEANUP_SYSTEM_PROMPT = `You are writing one-line cleanup rationales for an admin dashboard. Each rationale explains why a single listing should be deactivated, deleted, or marked low-quality.

Hard rules:
- One line per listing, max 140 chars.
- Cite the specific signal (last_seen days, missing fields, score).
- Banned words: luxury, modern, stunning, must-see, charming, cozy, seamless, robust, elevated, delightful, vibrant.
- No em dashes. Use periods or commas.
- No filler ("This listing", "It looks like"). Lead with the signal.

You will receive an array of candidates. Call emit_rationales exactly once with one rationale per candidate, same order.`

const CLEANUP_TOOL = {
  name: 'emit_rationales',
  description: 'Emit one rationale per cleanup candidate, in the same order.',
  input_schema: {
    type: 'object' as const,
    properties: {
      rationales: {
        type: 'array' as const,
        items: { type: 'string' as const, maxLength: 200 },
        description: 'One rationale per candidate, same order as input.',
      },
    },
    required: ['rationales'],
  },
}

type CleanupCandidate = {
  listing_id: string
  action: CleanupAction
  signal: string // deterministic phrase the LLM expands
  listing_summary: string
  source_url: string
}

function summarizeListingForCleanup(l: Listing, score?: number | null): string {
  const parts: string[] = []
  if (l.price_monthly != null) parts.push(`$${l.price_monthly.toLocaleString('en-US')}`)
  if (l.beds) parts.push(`${l.beds}br`)
  if (l.neighborhood) parts.push(l.neighborhood)
  parts.push(l.source)
  if (score != null) parts.push(`score ${score}`)
  return parts.join(', ')
}

export async function recommendCleanup(): Promise<CleanupSuggestion[]> {
  // Pull all listings (active + inactive). getRankedFeed only returns active +
  // scored, so we go to DB directly here. Keep the read narrow.
  let rows: Listing[] = []
  let scoreByListing = new Map<string, number>()
  try {
    const db = getDb()
    rows = (await db.select().from(listingsTable)) as Listing[]
    const scoreRows = (await db
      .select({
        listing_id: scoresTable.listing_id,
        score: sql<number>`MAX(${scoresTable.score})`,
      })
      .from(scoresTable)
      .groupBy(scoresTable.listing_id)) as Array<{ listing_id: string; score: number }>
    scoreByListing = new Map(scoreRows.map((r) => [r.listing_id, r.score]))
  } catch (err) {
    console.warn(`[insights] recommendCleanup DB read failed: ${(err as Error).message}`)
    return []
  }

  const candidates: CleanupCandidate[] = []
  const now = Date.now()
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

  for (const l of rows) {
    // 1) last_seen >7d AND is_active=true → probably gone
    if (l.is_active && l.last_seen_at && now - l.last_seen_at.getTime() > SEVEN_DAYS_MS) {
      const days = Math.round((now - l.last_seen_at.getTime()) / (24 * 60 * 60 * 1000))
      candidates.push({
        listing_id: l.id,
        action: 'deactivate',
        signal: `not seen in ${days}d, still flagged active`,
        listing_summary: summarizeListingForCleanup(l, scoreByListing.get(l.id)),
        source_url: l.source_url,
      })
      continue
    }

    // 2) no photos AND no contact AND no address → low data quality
    const photos = (l.photos ?? []).length
    const hasContact = !!l.contact && Object.keys(l.contact).length > 0
    const hasAddr = !!l.address && l.address.trim().length > 0
    if (l.is_active && photos === 0 && !hasContact && !hasAddr) {
      candidates.push({
        listing_id: l.id,
        action: 'mark-low-quality',
        signal: 'no photos, no contact, no address',
        listing_summary: summarizeListingForCleanup(l, scoreByListing.get(l.id)),
        source_url: l.source_url,
      })
      continue
    }

    // 3) score <30 across all profile sets
    const s = scoreByListing.get(l.id)
    if (l.is_active && s != null && s < LOW_QUALITY_SCORE_CUTOFF) {
      candidates.push({
        listing_id: l.id,
        action: 'mark-low-quality',
        signal: `score ${s} below cutoff ${LOW_QUALITY_SCORE_CUTOFF}`,
        listing_summary: summarizeListingForCleanup(l, s),
        source_url: l.source_url,
      })
    }
  }

  // Cap LLM call size; never ship more than 30 candidates per pass.
  const capped = candidates.slice(0, 30)
  if (capped.length === 0) return []

  // Build LLM input. If no key, return deterministic rationales.
  if (!process.env.ANTHROPIC_API_KEY) {
    return capped.map((c) => ({
      listing_id: c.listing_id,
      action: c.action,
      reason: lintVoice(`${c.signal}.`),
      listing_summary: c.listing_summary,
      source_url: c.source_url,
    }))
  }

  try {
    const client = getAnthropic()
    const userPayload = capped.map((c, i) => ({
      i,
      action: c.action,
      signal: c.signal,
      summary: c.listing_summary,
    }))
    // Rightsizing: cleanup rationales are short (≤140 chars), the deterministic
    // signal already supplies all the structure, and the model is just rephrasing
    // 1-2 facts into compliant voice. Haiku handles this with no quality drop
    // for ~5x lower cost than Sonnet. (Market summary still uses Sonnet —
    // synthesis quality matters there.)
    const response = await client.messages.create({
      model: MODELS.extract,
      max_tokens: 2048,
      temperature: 0.2,
      system: [
        {
          // Cache breakpoint: system prompt is stable across every cleanup
          // batch invocation, so the prompt cache hits >90% after the first
          // run. Dynamic per-batch payload is in `messages.user.content`,
          // strictly AFTER the cache_control marker.
          type: 'text',
          text: CLEANUP_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      tools: [CLEANUP_TOOL],
      tool_choice: { type: 'tool', name: 'emit_rationales' },
      messages: [
        {
          role: 'user',
          content: `Write one cleanup rationale per candidate, same order. Candidates:\n\n${JSON.stringify(userPayload, null, 2)}`,
        },
      ],
    })

    const toolBlock = response.content.find((b) => b.type === 'tool_use')
    if (!toolBlock || toolBlock.type !== 'tool_use') {
      throw new Error('no tool_use block in cleanup response')
    }
    const out = toolBlock.input as { rationales: string[] }
    if (!Array.isArray(out.rationales) || out.rationales.length !== capped.length) {
      throw new Error(`malformed cleanup output: expected ${capped.length} rationales, got ${out.rationales?.length}`)
    }

    return capped.map((c, i) => ({
      listing_id: c.listing_id,
      action: c.action,
      reason: lintVoice(out.rationales[i] ?? c.signal),
      listing_summary: c.listing_summary,
      source_url: c.source_url,
    }))
  } catch (err) {
    console.warn(`[insights] cleanup LLM call failed: ${(err as Error).message}`)
    return capped.map((c) => ({
      listing_id: c.listing_id,
      action: c.action,
      reason: lintVoice(`${c.signal}.`),
      listing_summary: c.listing_summary,
      source_url: c.source_url,
    }))
  }
}

// ---------- 4. apply cleanup ----------

/**
 * Server-side execution of a cleanup decision. Called by the POST handler in
 * `/api/admin/insights` after the user clicks Apply on a row. We never
 * auto-execute these. The suggestion alone surfaces in the UI.
 *
 * `delete` cascades through `scores` (FK is ON DELETE CASCADE).
 */
export async function applyCleanup(args: {
  listing_id: string
  action_type: 'deactivate' | 'delete'
}): Promise<{ ok: true; action: string; listing_id: string }> {
  const db = getDb()
  if (args.action_type === 'deactivate') {
    await db
      .update(listingsTable)
      .set({ is_active: false })
      .where(eq(listingsTable.id, args.listing_id))
  } else if (args.action_type === 'delete') {
    await db.delete(listingsTable).where(eq(listingsTable.id, args.listing_id))
  } else {
    throw new Error(`unknown action_type: ${args.action_type as string}`)
  }
  return { ok: true, action: args.action_type, listing_id: args.listing_id }
}

// Export the system prompts so the report can quote them verbatim.
export const SYSTEM_PROMPTS = {
  market: MARKET_SYSTEM_PROMPT,
  cleanup: CLEANUP_SYSTEM_PROMPT,
} as const
