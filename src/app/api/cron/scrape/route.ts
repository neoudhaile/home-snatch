/**
 * GET /api/cron/scrape — Vercel Cron entrypoint.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}`. Vercel Cron sets this header
 * automatically when `CRON_SECRET` is configured as an env var on the project.
 *
 * Behavior:
 *   - Calls `fetchAllSources()`.
 *   - Upserts every listing on `source_url`, refreshing `last_seen_at` on
 *     re-seen rows so they retain freshness.
 *   - Marks any listing not seen in ≥30 days as `is_active=false`.
 */

import { sql } from 'drizzle-orm'
import { fetchAllSources } from '@/scrapers'
import { getDb } from '@/lib/db'
import { listings } from '@/db/schema'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Allow up to 5 minutes for the full cron pass (Vercel's max for hobby/pro tier).
export const maxDuration = 300

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // dev-only: no secret set → allow
  const got = req.headers.get('authorization') ?? ''
  return got === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const { listings: fresh, bySource } = await fetchAllSources()

  const db = getDb()
  let ingested = 0
  // Upsert in chunks to keep statement size manageable (jsonb columns are heavy).
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

  // Deactivate stale listings (not re-seen in 30+ days).
  const deactivated = await db
    .update(listings)
    .set({ is_active: false })
    .where(sql`${listings.is_active} = true AND ${listings.last_seen_at} < now() - interval '30 days'`)
    .returning({ id: listings.id })

  return Response.json({
    ingested,
    deactivated: deactivated.length,
    sources: bySource,
  })
}
