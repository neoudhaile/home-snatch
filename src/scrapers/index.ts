/**
 * Source orchestrator. Calls each scraper, dedupes by `source_url`, and
 * partitions results by source for telemetry.
 *
 * Failures of any single source are logged and swallowed — one bad scrape must
 * not block the rest.
 */

import pLimit from 'p-limit'
import type { NewListing, Source } from '@/types'
import { fetchCraigslist } from './craigslist'
import { fetchReddit } from './reddit'
import { fetchListingsProject } from './listings-project'
import {
  runApartmentsSearchNYC,
  runStreeteasySearchNYC,
  runTruliaSearchNYC,
  runZillowSearchNYC,
} from './apify'
import { logScrapeError } from './_util'

export type FetchAllResult = {
  listings: NewListing[]
  bySource: Partial<Record<Source, number>>
}

type SourceFn = () => Promise<NewListing[]>

const SOURCES: Array<{ name: Source; fn: SourceFn }> = [
  { name: 'craigslist', fn: fetchCraigslist },
  { name: 'reddit', fn: fetchReddit },
  { name: 'listings-project', fn: fetchListingsProject },
  { name: 'zillow', fn: runZillowSearchNYC },
  { name: 'streeteasy', fn: runStreeteasySearchNYC },
  { name: 'trulia', fn: runTruliaSearchNYC },
  { name: 'apartments', fn: runApartmentsSearchNYC },
]

/**
 * Fetch every source in parallel (cap=2 concurrent so we don't slam Apify or
 * burn through Anthropic creds), dedupe by `source_url`, return combined.
 */
export async function fetchAllSources(): Promise<FetchAllResult> {
  const limit = pLimit(2)
  const settled = await Promise.allSettled(
    SOURCES.map(({ name, fn }) =>
      limit(async () => {
        try {
          const out = await fn()
          return { name, out }
        } catch (err) {
          logScrapeError(name, '(top-level)', err)
          return { name, out: [] as NewListing[] }
        }
      })
    )
  )

  const bySource: Partial<Record<Source, number>> = {}
  const seen = new Set<string>()
  const listings: NewListing[] = []
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    const { name, out } = r.value
    bySource[name] = out.length
    for (const l of out) {
      if (!l.source_url || seen.has(l.source_url)) continue
      seen.add(l.source_url)
      listings.push(l)
    }
  }
  return { listings, bySource }
}

export type { NewListing, Source }
