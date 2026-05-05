/**
 * POST /api/refresh — manual "scrape now" trigger from the feed UI.
 *
 * Architecture:
 *   1. Direct scrapers (Craigslist, Reddit, Listings Project) — broad NYC.
 *   2. Apify TARGETED scrapers (Zillow, StreetEasy, Apartments, Realtor) —
 *      one search per joint `preferred_areas` entry, capped at 4.
 *
 * The Apify path is gated on APIFY_TOKEN. Without it we fall back to direct-
 * only (the old behavior). Apify runs share a 60s wall-clock budget so a slow
 * actor can't starve the response — `Promise.race` against the timeout
 * surfaces whatever's already arrived as a partial result.
 *
 * Response shape:
 *   { ingested: number,
 *     by_source: Record<Source, number>,
 *     duration_ms: number,
 *     apify: 'used' | 'timeout' | 'skipped' | 'error',
 *     ingested_direct: number,
 *     ingested_apify: number }
 *
 * Auth: none in v0 — the obscure Vercel subdomain is the gate. TODO: add
 * proper auth before any meaningful threat-model exposure.
 *
 * Idempotent on `source_url` — same upsert pattern as `scripts/scrape.ts`.
 */

import { sql } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { after } from 'next/server'
import pLimit from 'p-limit'
import type { NewListing, Source } from '@/types'
import { listings as listingsTable } from '@/db/schema'
import { getDb } from '@/lib/db'
import { fetchCraigslist } from '@/scrapers/craigslist'
import { fetchReddit } from '@/scrapers/reddit'
import { fetchListingsProject } from '@/scrapers/listings-project'
import {
  runApartmentsTargetedAreas,
  runRealtorTargetedAreas,
  runStreeteasyTargetedAreas,
  runZillowTargetedAreas,
} from '@/scrapers/apify'
import { logScrapeError } from '@/scrapers/_util'
import { chainRescoreAfter } from '@/lib/rescore-helper'
import { loadAllProfileFiles, mergeProfileConstraints } from '@/lib/profile-set'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Direct + targeted Apify path can take longer than the 60s Hobby cap; on
// Pro we have 300s. The Apify race uses a 60s internal timeout so the total
// path stays well under both ceilings even when the actors are slow.
export const maxDuration = 300

/** Hard wall-clock budget for the targeted-Apify race. */
const APIFY_BUDGET_MS = 60_000

type SourceFn = () => Promise<NewListing[]>

const DIRECT_SOURCES: Array<{ name: Source; label: string; fn: SourceFn }> = [
  { name: 'craigslist', label: 'craigslist:direct', fn: fetchCraigslist },
  { name: 'reddit', label: 'reddit:direct', fn: fetchReddit },
  { name: 'listings-project', label: 'listings-project:direct', fn: fetchListingsProject },
]

type ApifySource = {
  name: Source
  label: string
  fn: (areas: string[], budgetMax: number | null) => Promise<NewListing[]>
}

const APIFY_TARGETED_SOURCES: ApifySource[] = [
  { name: 'zillow', label: 'zillow:apify-targeted', fn: runZillowTargetedAreas },
  { name: 'streeteasy', label: 'streeteasy:apify-targeted', fn: runStreeteasyTargetedAreas },
  { name: 'apartments', label: 'apartments:apify-targeted', fn: runApartmentsTargetedAreas },
  { name: 'realtor', label: 'realtor:apify-targeted', fn: runRealtorTargetedAreas },
]

type ApifyOutcome = 'used' | 'timeout' | 'skipped' | 'error'

/**
 * Resolve the joint preferred_areas + budget cap from every profile in
 * `src/profiles/` (via the DB-first loader). Returns null on hard failure so
 * the caller can fall back to direct-only.
 */
async function jointPreferences(): Promise<{
  areas: string[]
  budgetMax: number | null
} | null> {
  try {
    const profiles = await loadAllProfileFiles()
    if (profiles.length === 0) return { areas: [], budgetMax: null }
    const joint = mergeProfileConstraints(profiles)
    return {
      areas: joint.preferred_areas.filter((a) => !a.includes('FILL_ME')),
      budgetMax: joint.budget_max,
    }
  } catch (err) {
    console.warn(`[refresh] loadAllProfileFiles failed: ${(err as Error).message}`)
    return null
  }
}

/**
 * Run the targeted Apify sources in parallel-2 (matches the cron pattern's
 * Apify concurrency). Fights against an outer wall-clock timeout via
 * Promise.race — whichever sources finished get added to the ingest stream;
 * the rest are abandoned (their internal AbortController stops the Apify
 * runs from leaking compute).
 *
 * Returns:
 *   - listings: every NewListing collected before the timeout
 *   - bySource: per-source counts (0 if the actor errored or timed out)
 *   - outcome: 'used' (everyone finished), 'timeout' (race lost),
 *              'skipped' (no token / no profiles), 'error'
 */
async function runTargetedApify(
  areas: string[],
  budgetMax: number | null,
): Promise<{
  listings: NewListing[]
  bySource: Partial<Record<Source, number>>
  outcome: ApifyOutcome
}> {
  if (!process.env.APIFY_TOKEN) {
    return { listings: [], bySource: {}, outcome: 'skipped' }
  }

  const bySource: Partial<Record<Source, number>> = {}
  const collected: NewListing[] = []

  const limit = pLimit(2)
  const tasks = APIFY_TARGETED_SOURCES.map((src) =>
    limit(async () => {
      try {
        const out = await src.fn(areas, budgetMax)
        bySource[src.name] = (bySource[src.name] ?? 0) + out.length
        collected.push(...out)
        return { name: src.name, n: out.length }
      } catch (err) {
        logScrapeError(src.label, '(targeted)', err)
        bySource[src.name] = bySource[src.name] ?? 0
        return { name: src.name, n: 0 }
      }
    }),
  )

  let outcome: ApifyOutcome = 'used'
  let timeoutFired = false
  const timeoutP = new Promise<'timeout'>((resolve) => {
    setTimeout(() => {
      timeoutFired = true
      resolve('timeout')
    }, APIFY_BUDGET_MS)
  })

  // We race the timeout against ALL tasks finishing; if the timeout wins, we
  // still return whatever the in-flight tasks managed to push into
  // `collected` before the abort propagates.
  const allDone = Promise.all(tasks).then(() => 'done' as const)
  const winner = await Promise.race([allDone, timeoutP])
  if (winner === 'timeout' || timeoutFired) outcome = 'timeout'

  return { listings: collected, bySource, outcome }
}

export async function POST() {
  const start = Date.now()

  // Kick off the direct scrapers and the joint-prefs read in parallel — both
  // are independent and the prefs read is cheap.
  const directP = Promise.allSettled(
    DIRECT_SOURCES.map(async ({ name, label, fn }) => {
      try {
        const out = await fn()
        return { name, out }
      } catch (err) {
        logScrapeError(label, '(top-level)', err)
        return { name, out: [] as NewListing[] }
      }
    }),
  )
  const prefsP = jointPreferences()

  const [settled, prefs] = await Promise.all([directP, prefsP])

  const bySource: Partial<Record<Source, number>> = {}
  const seen = new Set<string>()
  const fresh: NewListing[] = []
  let ingestedDirectStream = 0
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    const { name, out } = r.value
    bySource[name] = (bySource[name] ?? 0) + out.length
    for (const l of out) {
      if (!l.source_url || seen.has(l.source_url)) continue
      seen.add(l.source_url)
      fresh.push(l)
      ingestedDirectStream += 1
    }
  }

  // Targeted Apify pass — only when we have a token AND a profile-set to
  // target. If preferred_areas is empty we still kick it off so the user
  // gets *some* fresh inventory; the runners themselves fall back to a
  // single NYC-wide search in that case.
  let apifyOutcome: ApifyOutcome = 'skipped'
  let apifyBySource: Partial<Record<Source, number>> = {}
  let ingestedApifyStream = 0
  if (prefs && process.env.APIFY_TOKEN) {
    try {
      const { listings: apifyListings, bySource: apifyCounts, outcome } =
        await runTargetedApify(prefs.areas, prefs.budgetMax)
      apifyOutcome = outcome
      apifyBySource = apifyCounts
      for (const [k, n] of Object.entries(apifyCounts)) {
        const key = k as Source
        bySource[key] = (bySource[key] ?? 0) + (n as number)
      }
      for (const l of apifyListings) {
        if (!l.source_url || seen.has(l.source_url)) continue
        seen.add(l.source_url)
        fresh.push(l)
        ingestedApifyStream += 1
      }
    } catch (err) {
      apifyOutcome = 'error'
      logScrapeError('refresh:apify-targeted', '(top-level)', err)
    }
  }

  if (fresh.length === 0) {
    return Response.json({
      ingested: 0,
      by_source: bySource,
      duration_ms: Date.now() - start,
      apify: apifyOutcome,
      apify_by_source: apifyBySource,
      ingested_direct: 0,
      ingested_apify: 0,
    })
  }

  const db = getDb()
  let ingested = 0
  const ingestedIds: string[] = []
  // Smaller chunk than the cron route so we stay well under the 60s ceiling.
  const CHUNK = 50
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const batch = fresh.slice(i, i + CHUNK)
    if (batch.length === 0) continue
    const rows = await db
      .insert(listingsTable)
      .values(batch)
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
          posted_at: sql`excluded.posted_at`,
          last_seen_at: sql`now()`,
          is_active: sql`true`,
          raw: sql`excluded.raw`,
        },
      })
      .returning({ id: listingsTable.id })
    ingested += rows.length
    for (const r of rows) ingestedIds.push(r.id)
  }

  // Chain a background rescore — the manual "scrape now" used to dump fresh
  // listings into the feed without scores, which surfaced as score-less cards.
  if (ingestedIds.length > 0) {
    after(() => chainRescoreAfter(ingestedIds))
  }

  // Bust the feed + dq caches so the next render reflects the upsert.
  try {
    revalidateTag('feed', 'max')
    revalidateTag('dq', 'max')
  } catch {
    /* outside request scope — ignore */
  }

  return Response.json({
    ingested,
    by_source: bySource,
    duration_ms: Date.now() - start,
    apify: apifyOutcome,
    apify_by_source: apifyBySource,
    ingested_direct: ingestedDirectStream,
    ingested_apify: ingestedApifyStream,
  })
}
