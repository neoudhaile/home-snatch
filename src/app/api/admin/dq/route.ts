/**
 * Admin DQ endpoint.
 *
 *   GET  /api/admin/dq                  → JSON metrics for the dashboard
 *   POST /api/admin/dq  { action }      → run a maintenance task
 *     - action: 'dedupe'         → mark duplicate listings inactive
 *     - action: 'scrape'         → run all source scrapers + upsert
 *     - action: 'refresh'        → re-fetch stale listings
 *     - action: 'rescore'        → score listings missing a current score
 *     - action: 'recompute-vibes'→ recompute neighborhood vibe table
 *
 * Auth (v0): obscure URL + optional `x-admin-pass` header against ADMIN_PASS.
 * TODO(phase 2): wire to a real session check before any external exposure.
 */
import { z } from 'zod'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { listings, scores, subway_stations } from '@/db/schema'
import { getDb } from '@/lib/db'
import { getDqMetrics } from '@/lib/data-quality'
import { markDuplicates } from '@/lib/listing-dedupe'
import { refreshStaleListings } from '@/lib/listing-freshness'
import { scoreListings } from '@/agents/score'
import { computeNeighborhoodVibes } from '@/lib/nyc-vibes'
import {
  hashProfileSet,
  loadProfilesFromJson,
} from '@/lib/profile-set'
import { fetchAllSources } from '@/scrapers'
import type { Listing, SubwayStation } from '@/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

const Body = z.object({
  action: z.enum(['dedupe', 'scrape', 'refresh', 'rescore', 'recompute-vibes']),
})

function authorized(req: Request): boolean {
  const expected = process.env.ADMIN_PASS
  if (!expected) return true // dev convenience: no pass set → allow
  const got = req.headers.get('x-admin-pass') ?? ''
  return got === expected
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const metrics = await getDqMetrics()
  return Response.json(metrics)
}

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'bad request'
    return Response.json({ error: 'bad_request', message: msg }, { status: 400 })
  }

  switch (body.action) {
    case 'dedupe':
      return Response.json(await markDuplicates())
    case 'scrape':
      return Response.json(await runScrape())
    case 'refresh':
      return Response.json(await refreshStaleListings())
    case 'rescore':
      return Response.json(await runRescore())
    case 'recompute-vibes':
      await computeNeighborhoodVibes()
      return Response.json({ ok: true })
    default:
      return Response.json({ error: 'unknown_action' }, { status: 400 })
  }
}

// ---------- helpers ----------

/**
 * Mirror of `/api/cron/scrape` upsert path, but invoked directly so the admin
 * dashboard doesn't need the cron secret. Uses the same `excluded.*` set.
 */
async function runScrape(): Promise<{
  ingested: number
  deactivated: number
  sources: Partial<Record<string, number>>
}> {
  const { listings: fresh, bySource } = await fetchAllSources()
  const db = getDb()
  let ingested = 0
  const CHUNK = 50
  for (let i = 0; i < fresh.length; i += CHUNK) {
    const batch = fresh.slice(i, i + CHUNK)
    if (batch.length === 0) continue
    const rows = await db
      .insert(listings)
      .values(batch)
      .onConflictDoUpdate({
        target: listings.source_url,
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
      .returning({ id: listings.id })
    ingested += rows.length
  }

  const deactivated = await db
    .update(listings)
    .set({ is_active: false })
    .where(sql`${listings.is_active} = true AND ${listings.last_seen_at} < now() - interval '30 days'`)
    .returning({ id: listings.id })

  return { ingested, deactivated: deactivated.length, sources: bySource }
}

/**
 * Score every active listing that does NOT have a row in `scores` for the
 * current joint profile-set hash. Re-enriches via `scoreListings` (subway,
 * HPD, rent-stab pulled fresh).
 *
 * Note: this calls `scoreListings` from the scoring agent, which already
 * runs the full enrichment pipeline. We do not call `enrichListing` directly.
 */
async function runRescore(): Promise<{ scored: number; profile_set_hash: string }> {
  const db = getDb()
  const profiles = await loadProfilesFromJson()
  if (profiles.length === 0) {
    return { scored: 0, profile_set_hash: '' }
  }
  const profileSetHash = hashProfileSet(profiles)

  // Active listings that don't have a score row for this hash.
  const candidates = (await db
    .select()
    .from(listings)
    .leftJoin(
      scores,
      and(eq(scores.listing_id, listings.id), eq(scores.profile_set_hash, profileSetHash))
    )
    .where(and(eq(listings.is_active, true), isNull(scores.listing_id)))) as Array<{
    listings: Listing
  }>

  const targetListings = candidates.map((c) => c.listings)
  if (targetListings.length === 0) {
    return { scored: 0, profile_set_hash: profileSetHash }
  }

  // Pre-resolve the lookup tables `scoreListings` expects.
  const stations = (await db.select().from(subway_stations)) as SubwayStation[]

  // HPD + rent-stab are keyed by BBL in DB. The v0 schema doesn't link
  // `listings.bbl` yet, so we pass empty maps; `scoreListings` tolerates 0/false.
  // If/when BBL gets attached to `listings`, swap in joins on hpd_violations +
  // rent_stabilized_buildings here.
  const hpdByListingId = new Map<string, number>()
  const rentStabByListingId = new Map<string, boolean>()

  const newScores = await scoreListings(targetListings, {
    stations,
    hpdByListingId,
    rentStabByListingId,
  })

  if (newScores.length === 0) {
    return { scored: 0, profile_set_hash: profileSetHash }
  }

  // Upsert each score row.
  for (const row of newScores) {
    await db
      .insert(scores)
      .values(row)
      .onConflictDoUpdate({
        target: [scores.listing_id, scores.profile_set_hash],
        set: {
          score: row.score,
          headline: row.headline,
          concerns: row.concerns,
          rationale_jsonb: row.rationale_jsonb,
          computed_at: sql`now()`,
        },
      })
  }

  return { scored: newScores.length, profile_set_hash: profileSetHash }
}
