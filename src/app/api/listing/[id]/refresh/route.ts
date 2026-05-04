/**
 * POST /api/listing/[id]/refresh — re-fetch the listing's source URL, update
 * `last_seen_at`, and (if the upstream is gone) mark `is_active=false`.
 *
 * Returns: `{ status, last_seen_at, photos_changed, reason }`. The detail page
 * surfaces this on a "refresh now" button.
 */
import { z } from 'zod'
import { refreshSingleListing } from '@/lib/listing-freshness'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Id = z.string().uuid()

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  let listingId: string
  try {
    listingId = Id.parse(id)
  } catch {
    return Response.json({ error: 'invalid_id' }, { status: 400 })
  }

  const result = await refreshSingleListing(listingId)
  return Response.json({
    status: result.status,
    last_seen_at: result.last_seen_at.toISOString(),
    photos_changed: result.photos_changed,
    reason: result.reason,
  })
}
