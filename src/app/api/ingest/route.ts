/**
 * POST /api/ingest — manually paste a single URL and have it extracted +
 * upserted into `listings`.
 *
 * Body: `{ url: string }`. Returns the persisted row on success, 422 with a
 * reason on extraction failure, 400 on bad input.
 */

import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { extractFromUrl } from '@/agents/extract'
import { getDb } from '@/lib/db'
import { listings } from '@/db/schema'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Body = z.object({ url: z.string().url() })

export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>
  try {
    const body = (await req.json()) as unknown
    parsed = Body.parse(body)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body'
    return Response.json({ error: 'bad_request', message: msg }, { status: 400 })
  }

  const listing = await extractFromUrl(parsed.url)
  if (!listing) {
    return Response.json(
      { error: 'extraction_failed', message: 'No extractor tier yielded a listing for this URL.' },
      { status: 422 }
    )
  }

  const db = getDb()
  const [row] = await db
    .insert(listings)
    .values(listing)
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
    .returning()

  return Response.json({ listing: row }, { status: 200 })
}
