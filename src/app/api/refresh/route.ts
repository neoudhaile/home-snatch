/**
 * POST /api/refresh — manual "scrape now" trigger from the feed UI.
 *
 * Lightweight by design: only direct fetchers (Craigslist, Reddit, Listings
 * Project), NEVER Apify. Vercel Hobby has a 60s function cap; Apify runs
 * routinely take longer than that. Apify-mediated scrapes only run from the
 * GitHub Actions cron (5-minute budget there).
 *
 * Auth: none in v0 — the obscure Vercel subdomain is the gate. TODO: add
 * proper auth before any meaningful threat-model exposure.
 *
 * Response shape:
 *   { ingested: number, by_source: Record<Source, number>, duration_ms: number }
 *
 * Idempotent on `source_url` — same upsert pattern as `scripts/scrape.ts`.
 */

import { sql } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { after } from 'next/server'
import type { NewListing, Source } from '@/types'
import { listings as listingsTable } from '@/db/schema'
import { getDb } from '@/lib/db'
import { fetchCraigslist } from '@/scrapers/craigslist'
import { fetchReddit } from '@/scrapers/reddit'
import { fetchListingsProject } from '@/scrapers/listings-project'
import { logScrapeError } from '@/scrapers/_util'
import { chainRescoreAfter } from '@/lib/rescore-helper'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Direct scrapers fan out across many CL boroughs + 17 subreddits — give
// ourselves a 60s ceiling matching Vercel Hobby.
export const maxDuration = 300

type SourceFn = () => Promise<NewListing[]>

const DIRECT_SOURCES: Array<{ name: Source; label: string; fn: SourceFn }> = [
  { name: 'craigslist', label: 'craigslist:direct', fn: fetchCraigslist },
  { name: 'reddit', label: 'reddit:direct', fn: fetchReddit },
  { name: 'listings-project', label: 'listings-project:direct', fn: fetchListingsProject },
]

export async function POST() {
  const start = Date.now()

  // Run all direct sources in parallel, swallowing per-source failures so one
  // bad scraper doesn't kill the whole refresh.
  const settled = await Promise.allSettled(
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

  const bySource: Partial<Record<Source, number>> = {}
  const seen = new Set<string>()
  const fresh: NewListing[] = []
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue
    const { name, out } = r.value
    bySource[name] = (bySource[name] ?? 0) + out.length
    for (const l of out) {
      if (!l.source_url || seen.has(l.source_url)) continue
      seen.add(l.source_url)
      fresh.push(l)
    }
  }

  if (fresh.length === 0) {
    return Response.json({
      ingested: 0,
      by_source: bySource,
      duration_ms: Date.now() - start,
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
  })
}
