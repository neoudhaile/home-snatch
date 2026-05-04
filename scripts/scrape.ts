/**
 * Manual scrape entrypoint — `npm run scrape`.
 *
 * Runs every source in `src/scrapers/index.ts`, upserts to `listings` (idempotent
 * on `source_url`), and refreshes `last_seen_at` for re-seen rows. Marks listings
 * not seen in 30+ days as `is_active = false`.
 *
 * Used both locally (developer triggers) and from the GitHub Actions cron in
 * `.github/workflows/scrape.yml`. Vercel Cron's `/api/cron/scrape` route shares
 * the same upsert logic in route form.
 */
import { sql } from 'drizzle-orm'
import { listings as listingsTable } from '@/db/schema'
import { getDb } from '@/lib/db'
import { fetchAllSources } from '@/scrapers'

async function main() {
  const start = Date.now()
  console.log('[scrape] starting')

  const { listings, bySource } = await fetchAllSources()
  console.log(
    '[scrape] fetched',
    listings.length,
    'unique listings; by source:',
    bySource
  )

  if (listings.length === 0) {
    console.log('[scrape] nothing to upsert; done in', Math.round((Date.now() - start) / 1000), 's')
    process.exit(0)
  }

  const db = getDb()

  // Upsert in chunks of 200 (Postgres parameter cap is ~64k; each row uses
  // ~25 params so 200 is safe and chunks aren't too big to roll back if
  // something goes wrong).
  const CHUNK = 200
  let ingested = 0
  for (let i = 0; i < listings.length; i += CHUNK) {
    const slice = listings.slice(i, i + CHUNK)
    await db
      .insert(listingsTable)
      .values(slice)
      .onConflictDoUpdate({
        target: listingsTable.source_url,
        set: {
          // Preserve original posted_at, raw, fetched_at; refresh display fields
          // and last_seen_at so freshness math is correct.
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
    ingested += slice.length
    console.log(`[scrape] upserted ${ingested}/${listings.length}`)
  }

  // Mark long-unseen listings inactive (>30 days since last_seen_at).
  const deactivated = await db.execute(sql`
    UPDATE listings
    SET is_active = false
    WHERE is_active = true
      AND last_seen_at < (now() - interval '30 days')
  `)
  const deactivatedCount = (deactivated as unknown as { rowCount?: number }).rowCount ?? 0

  console.log(
    `[scrape] done in ${Math.round((Date.now() - start) / 1000)}s — ingested ${ingested}, deactivated ${deactivatedCount}`
  )
  process.exit(0)
}

main().catch((err) => {
  console.error('[scrape] fatal', err)
  process.exit(1)
})
