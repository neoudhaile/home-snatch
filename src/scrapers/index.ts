/**
 * Source orchestrator. Calls each scraper, dedupes by `source_url`, and
 * partitions results by source for telemetry.
 *
 * Failures of any single source are logged and swallowed — one bad scrape must
 * not block the rest.
 *
 * Source roster (2026-05-04):
 *   Direct (free):
 *     - craigslist     — 5 boroughs, search + detail
 *     - reddit         — 17 subs, /new + /search, Haiku-classified
 *     - listings-project — Next-data + JSON-LD + HTML fallback
 *     - hotpads        — direct probe; Apify failover handles blocked path
 *     - renthop        — direct probe; Apify failover handles blocked path
 *
 *   Apify (token-gated):
 *     - zillow         — `maxcopell~zillow-detail-scraper`
 *     - streeteasy     — `epctex~streeteasy-scraper`
 *     - trulia         — `epctex~trulia-scraper`
 *     - apartments     — `epctex~apartments-scraper`
 *     - realtor        — `epctex~realtor-scraper`
 *     - redfin         — `epctex~redfin-scraper`
 *     - hotpads        — `epctex~hotpads-scraper`
 *     - renthop        — `epctex~renthop-scraper`
 *     - twitter        — `apidojo~twitter-scraper-lite`
 *
 *   Direct + Apify dedupe by `source_url`, so the dual coverage on hotpads /
 *   renthop is safe — Apify is the failover when direct is Cloudflare-blocked.
 *
 * Each source-fn is registered with its `Source` tag; orchestrator preserves
 * the tag in `bySource` telemetry. Source order in `SOURCES` is independent of
 * orchestrator order.
 */

import pLimit from 'p-limit'
import type { NewListing, Source } from '@/types'
import { fetchCraigslist } from './craigslist'
import { fetchReddit } from './reddit'
import { fetchListingsProject } from './listings-project'
import { fetchHotPads } from './hotpads'
import { fetchRenthop } from './renthop'
import {
  runApartmentsSearchNYC,
  runHotPadsSearchNYC,
  runRealtorSearchNYC,
  runRedfinSearchNYC,
  runRentHopSearchNYC,
  runStreeteasySearchNYC,
  runTruliaSearchNYC,
  runTwitterSearchNYC,
  runZillowSearchNYC,
} from './apify'
import { logScrapeError } from './_util'

export type FetchAllResult = {
  listings: NewListing[]
  bySource: Partial<Record<Source, number>>
}

type SourceFn = () => Promise<NewListing[]>

/**
 * Each entry is a (source_tag, runner) pair. Source tags can repeat: the
 * `hotpads` and `renthop` rows show up twice — once for the direct scraper,
 * once for the Apify-mediated runner. Both contribute to the same `Source`
 * bucket in telemetry; dedup by source_url collapses any cross-tier overlap.
 */
const SOURCES: Array<{ name: Source; label: string; fn: SourceFn }> = [
  // Free / direct ------------------------------------------------------------
  { name: 'craigslist', label: 'craigslist:direct', fn: fetchCraigslist },
  { name: 'reddit', label: 'reddit:direct', fn: fetchReddit },
  { name: 'listings-project', label: 'listings-project:direct', fn: fetchListingsProject },
  { name: 'hotpads', label: 'hotpads:direct', fn: fetchHotPads },
  { name: 'renthop', label: 'renthop:direct', fn: fetchRenthop },
  // Apify --------------------------------------------------------------------
  { name: 'zillow', label: 'zillow:apify', fn: runZillowSearchNYC },
  { name: 'streeteasy', label: 'streeteasy:apify', fn: runStreeteasySearchNYC },
  { name: 'trulia', label: 'trulia:apify', fn: runTruliaSearchNYC },
  { name: 'apartments', label: 'apartments:apify', fn: runApartmentsSearchNYC },
  { name: 'realtor', label: 'realtor:apify', fn: runRealtorSearchNYC },
  { name: 'redfin', label: 'redfin:apify', fn: runRedfinSearchNYC },
  { name: 'hotpads', label: 'hotpads:apify', fn: runHotPadsSearchNYC },
  { name: 'renthop', label: 'renthop:apify', fn: runRentHopSearchNYC },
  { name: 'twitter', label: 'twitter:apify', fn: runTwitterSearchNYC },
]

/**
 * Fetch every source in parallel (cap=5 concurrent on Vercel Pro — sources are
 * mostly independent and Pro has the memory headroom; was 2 on hobby tier),
 * dedupe by `source_url`, return combined.
 *
 * `bySource` totals merge cross-tier rows (so direct + Apify hotpads roll up
 * into one `hotpads` count).
 */
export async function fetchAllSources(): Promise<FetchAllResult> {
  const limit = pLimit(5)
  const settled = await Promise.allSettled(
    SOURCES.map(({ name, label, fn }) =>
      limit(async () => {
        try {
          const out = await fn()
          return { name, label, out }
        } catch (err) {
          logScrapeError(label, '(top-level)', err)
          return { name, label, out: [] as NewListing[] }
        }
      }),
    ),
  )

  const bySource: Partial<Record<Source, number>> = {}
  const seen = new Set<string>()
  const listings: NewListing[] = []
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    const { name, out } = r.value
    bySource[name] = (bySource[name] ?? 0) + out.length
    for (const l of out) {
      if (!l.source_url || seen.has(l.source_url)) continue
      seen.add(l.source_url)
      listings.push(l)
    }
  }
  return { listings, bySource }
}

export type { NewListing, Source }
