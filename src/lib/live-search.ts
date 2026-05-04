/**
 * On-demand live search across Apify real-estate actors. Used by the chat
 * `live_search` tool when the user asks for something the DB might not have
 * yet — a niche neighborhood + amenity combo, or "show me listings posted in
 * the last hour".
 *
 * Pipeline:
 *   1. parseSearchQuery(query)     — Haiku extracts structured filters
 *   2. fan out to requested Apify sources in parallel (pLimit=2),
 *      each capped at max_results_per_source and a 60s AbortController
 *   3. dedupe by source_url across sources
 *   4. upsert to DB (same shape as scripts/scrape.ts)
 *   5. score new (newly-inserted) listings via scoreListings, capped at 5
 *      per call to keep Anthropic budget bounded
 *   6. return { count, listings, sources_hit, sources_skipped }
 *
 * NOT used for routine "show me top 5" queries — those should use
 * list_listings against the cached DB. Live search costs Apify $$ and ~10–60s
 * per source.
 */

import pLimit from 'p-limit'
import { sql, inArray } from 'drizzle-orm'
import type { NewListing, Listing } from '@/types'
import { listings as listingsTable, scores as scoresTable, subway_stations } from '@/db/schema'
import { getDb } from '@/lib/db'
import { parseSearchQuery, type ExtractedFilters } from '@/lib/search'
import { loadAllProfileFiles } from '@/lib/profile-set'
import { scoreListings } from '@/agents/score'
import {
  runApartmentsSearchNYC,
  runRealtorSearchNYC,
  runStreeteasySearchNYC,
  runZillowSearchNYC,
} from '@/scrapers/apify'

export type LiveSource = 'zillow' | 'streeteasy' | 'apartments' | 'realtor'

export const ALL_LIVE_SOURCES: LiveSource[] = [
  'zillow',
  'streeteasy',
  'apartments',
  'realtor',
]

const SOURCE_RUNNERS: Record<LiveSource, () => Promise<NewListing[]>> = {
  zillow: runZillowSearchNYC,
  streeteasy: runStreeteasySearchNYC,
  apartments: runApartmentsSearchNYC,
  realtor: runRealtorSearchNYC,
}

const PER_SOURCE_TIMEOUT_MS = 60_000
const MAX_NEW_SCORED_PER_CALL = 5

export type LiveSearchSummary = {
  id: string
  title: string
  source: string
  source_url: string
  price_monthly: number | null
  beds: string | null
  baths: string | null
  neighborhood: string | null
  borough: string | null
  score: number | null
  headline: string | null
  was_new: boolean
}

export type LiveSearchResult = {
  query: string
  intent_summary: string
  filters: ExtractedFilters
  count: number
  new_count: number
  scored_count: number
  listings: LiveSearchSummary[]
  sources_hit: LiveSource[]
  sources_skipped: Array<{ source: LiveSource; reason: string }>
  duration_ms: number
}

/**
 * Race a promise against a timeout — returns null on timeout or on the
 * promise resolving to null. Errors are caught and treated as "skipped".
 */
async function withTimeout<T>(
  fn: () => Promise<T>,
  ms: number,
  label: string,
): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        ctrl.signal.addEventListener('abort', () => reject(new Error(`${label} timeout`)))
      }),
    ])
    return { ok: true, value }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'unknown error' }
  } finally {
    clearTimeout(timer)
  }
}

/** Cap each source's listings at N (server-side, post-mapper). */
function capPerSource(rows: NewListing[], n: number): NewListing[] {
  return rows.slice(0, Math.max(0, n))
}

/**
 * Run a live search. See module docstring for the full pipeline.
 */
export async function runLiveSearch(args: {
  query: string
  sources?: LiveSource[]
  max_results_per_source?: number
}): Promise<LiveSearchResult> {
  const start = Date.now()
  const sourcesRequested =
    args.sources && args.sources.length > 0 ? args.sources : ALL_LIVE_SOURCES
  const cap = Math.min(Math.max(args.max_results_per_source ?? 5, 1), 25)

  // 1. Parse the NL query into filters (Haiku).
  let filters: ExtractedFilters
  try {
    filters = await parseSearchQuery(args.query)
  } catch (err) {
    console.warn(
      '[live-search] parseSearchQuery failed, proceeding with empty filters:',
      (err as Error).message,
    )
    filters = { intent_summary: args.query }
  }

  // 2. Fan out to Apify sources (pLimit=2 so we don't hammer Apify).
  const limit = pLimit(2)
  const perSourceResults = await Promise.all(
    sourcesRequested.map((source) =>
      limit(async () => {
        const r = await withTimeout(
          () => SOURCE_RUNNERS[source](),
          PER_SOURCE_TIMEOUT_MS,
          `live-search:${source}`,
        )
        return { source, result: r }
      }),
    ),
  )

  const sourcesHit: LiveSource[] = []
  const sourcesSkipped: Array<{ source: LiveSource; reason: string }> = []
  const combined: NewListing[] = []
  for (const { source, result } of perSourceResults) {
    if (!result.ok) {
      sourcesSkipped.push({ source, reason: result.reason })
      continue
    }
    sourcesHit.push(source)
    combined.push(...capPerSource(result.value, cap))
  }

  // 3. Dedupe by source_url across sources.
  const seenUrls = new Set<string>()
  const deduped: NewListing[] = []
  for (const it of combined) {
    if (!it.source_url || seenUrls.has(it.source_url)) continue
    seenUrls.add(it.source_url)
    deduped.push(it)
  }

  if (deduped.length === 0) {
    return {
      query: args.query,
      intent_summary: filters.intent_summary || args.query,
      filters,
      count: 0,
      new_count: 0,
      scored_count: 0,
      listings: [],
      sources_hit: sourcesHit,
      sources_skipped: sourcesSkipped,
      duration_ms: Date.now() - start,
    }
  }

  // 4. Upsert to DB.
  const db = getDb()
  const upserted = await db
    .insert(listingsTable)
    .values(deduped)
    .onConflictDoUpdate({
      target: listingsTable.source_url,
      set: {
        title: sql`excluded.title`,
        description: sql`excluded.description`,
        price_monthly: sql`excluded.price_monthly`,
        beds: sql`excluded.beds`,
        baths: sql`excluded.baths`,
        sqft: sql`excluded.sqft`,
        available_date: sql`excluded.available_date`,
        lease_term: sql`excluded.lease_term`,
        furnished: sql`excluded.furnished`,
        pet_friendly: sql`excluded.pet_friendly`,
        amenities: sql`excluded.amenities`,
        photos: sql`excluded.photos`,
        address: sql`excluded.address`,
        unit: sql`excluded.unit`,
        neighborhood: sql`excluded.neighborhood`,
        borough: sql`excluded.borough`,
        zip: sql`excluded.zip`,
        lat: sql`excluded.lat`,
        lng: sql`excluded.lng`,
        contact: sql`excluded.contact`,
        application: sql`excluded.application`,
        last_seen_at: sql`now()`,
        is_active: sql`true`,
        raw: sql`excluded.raw`,
      },
    })
    .returning({
      id: listingsTable.id,
      source_url: listingsTable.source_url,
      fetched_at: listingsTable.fetched_at,
      last_seen_at: listingsTable.last_seen_at,
    })

  // 5. Determine which rows are NEW (fetched_at == last_seen_at-ish, within
  //    the last 60 seconds). Simpler heuristic: fetched_at within the call
  //    window. We use a tolerant 90s window since the upsert happened mid-call.
  const callStart = new Date(start - 5_000)
  const newRows = upserted.filter(
    (r) => r.fetched_at && new Date(r.fetched_at) >= callStart,
  )
  const newIds = newRows.map((r) => r.id)

  // 6. Score the newly-inserted listings (capped at MAX_NEW_SCORED_PER_CALL).
  let scoredCount = 0
  if (newIds.length > 0) {
    try {
      const scoreSlice = newIds.slice(0, MAX_NEW_SCORED_PER_CALL)
      const fullRows = await db
        .select()
        .from(listingsTable)
        .where(inArray(listingsTable.id, scoreSlice))

      if (fullRows.length > 0) {
        const profiles = await loadAllProfileFiles()
        const stations = await db.select().from(subway_stations)
        if (profiles.length > 0) {
          const newScores = await scoreListings(fullRows as Listing[], {
            profilesOverride: profiles,
            stations,
            hpdByListingId: new Map(),
            rentStabByListingId: new Map(),
          })
          for (const s of newScores) {
            await db
              .insert(scoresTable)
              .values(s)
              .onConflictDoUpdate({
                target: [scoresTable.listing_id, scoresTable.profile_set_hash],
                set: s,
              })
            scoredCount++
          }
        }
      }
    } catch (err) {
      console.warn('[live-search] scoring failed:', (err as Error).message)
    }
  }

  // 7. Build the response summary. We pull back top scoring rows for the
  //    listings we just touched; for unscored rows, score=null.
  const allTouchedIds = upserted.map((r) => r.id)
  const summaries: LiveSearchSummary[] = []
  if (allTouchedIds.length > 0) {
    const detail = await db
      .select()
      .from(listingsTable)
      .where(inArray(listingsTable.id, allTouchedIds))
    // Pull scores for these listings (any profile_set_hash — pick the first).
    const allScores = await db
      .select()
      .from(scoresTable)
      .where(inArray(scoresTable.listing_id, allTouchedIds))
    const scoreById = new Map<string, (typeof allScores)[number]>()
    for (const s of allScores) {
      // Keep the highest-scoring entry per listing if we got multiple hashes.
      const prev = scoreById.get(s.listing_id)
      if (!prev || s.score > prev.score) scoreById.set(s.listing_id, s)
    }
    const newIdSet = new Set(newIds)
    for (const l of detail) {
      const s = scoreById.get(l.id) ?? null
      summaries.push({
        id: l.id,
        title: l.title,
        source: l.source,
        source_url: l.source_url,
        price_monthly: l.price_monthly,
        beds: l.beds,
        baths: l.baths,
        neighborhood: l.neighborhood,
        borough: l.borough,
        score: s?.score ?? null,
        headline: s?.headline ?? null,
        was_new: newIdSet.has(l.id),
      })
    }
    // Sort: scored desc, then new-first, then by price asc as a tiebreak.
    summaries.sort((a, b) => {
      const sa = a.score ?? -1
      const sb = b.score ?? -1
      if (sa !== sb) return sb - sa
      if (a.was_new !== b.was_new) return a.was_new ? -1 : 1
      return (a.price_monthly ?? Infinity) - (b.price_monthly ?? Infinity)
    })
  }

  return {
    query: args.query,
    intent_summary: filters.intent_summary || args.query,
    filters,
    count: summaries.length,
    new_count: newIds.length,
    scored_count: scoredCount,
    listings: summaries,
    sources_hit: sourcesHit,
    sources_skipped: sourcesSkipped,
    duration_ms: Date.now() - start,
  }
}

