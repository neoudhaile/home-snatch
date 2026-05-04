/**
 * POST   /api/save   { listing_id, saved_by } → save (idempotent)
 * DELETE /api/save   { listing_id, saved_by } → unsave (idempotent)
 *
 * `saved_by` is one of 'inaan' | 'mekonnen' for now. The page-level UI is the
 * gate on which saver is acting; this route just persists the choice.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { saveListing, unsaveListing, isSaver } from '@/lib/save-state'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Body = z.object({
  listing_id: z.string().min(1),
  saved_by: z.string().refine(isSaver, { message: 'saved_by must be inaan or mekonnen' }),
})

async function parseBody(req: Request) {
  try {
    const raw = (await req.json()) as unknown
    return Body.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid body'
    return { error: msg } as const
  }
}

export async function POST(req: Request) {
  const parsed = await parseBody(req)
  if ('error' in parsed) {
    return Response.json({ error: 'bad_request', message: parsed.error }, { status: 400 })
  }
  await saveListing(parsed.listing_id, parsed.saved_by)
  revalidatePath('/saved')
  revalidatePath('/')
  return Response.json({ ok: true, saved: true }, { status: 200 })
}

export async function DELETE(req: Request) {
  const parsed = await parseBody(req)
  if ('error' in parsed) {
    return Response.json({ error: 'bad_request', message: parsed.error }, { status: 400 })
  }
  await unsaveListing(parsed.listing_id, parsed.saved_by)
  revalidatePath('/saved')
  revalidatePath('/')
  return Response.json({ ok: true, saved: false }, { status: 200 })
}
