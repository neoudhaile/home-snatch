/**
 * POST   /api/save   { listing_id, saved_by } → save (idempotent)
 * DELETE /api/save   { listing_id, saved_by } → unsave (idempotent)
 *
 * `saved_by` is a profile slug, validated against the live set of profile
 * JSONs in src/profiles/. The page-level UI is the gate on which saver is
 * acting; this route persists the choice and rejects unknown slugs.
 */

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { saveListing, unsaveListing } from '@/lib/save-state'
import { getKnownSavers, isValidSaver } from '@/lib/profile-set'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Body = z.object({
  listing_id: z.string().min(1),
  saved_by: z.string().min(1),
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

async function badSaver(saved_by: string) {
  const savers = await getKnownSavers()
  return Response.json(
    {
      error: 'bad_request',
      message: `saved_by '${saved_by}' is not a known profile slug`,
      valid_savers: savers,
    },
    { status: 400 },
  )
}

export async function POST(req: Request) {
  const parsed = await parseBody(req)
  if ('error' in parsed) {
    return Response.json({ error: 'bad_request', message: parsed.error }, { status: 400 })
  }
  if (!(await isValidSaver(parsed.saved_by))) {
    return badSaver(parsed.saved_by)
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
  if (!(await isValidSaver(parsed.saved_by))) {
    return badSaver(parsed.saved_by)
  }
  await unsaveListing(parsed.listing_id, parsed.saved_by)
  revalidatePath('/saved')
  revalidatePath('/')
  return Response.json({ ok: true, saved: false }, { status: 200 })
}
