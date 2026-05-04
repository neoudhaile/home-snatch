/**
 * /api/profile/[slug]  —  fetch / replace / delete a single profile.
 *
 * GET    -> 200 { profile } | 404
 * PUT    -> same body as POST /api/profile, full upsert by slug. Body's slug
 *          must match the URL slug; mismatch is 400.
 * DELETE -> 204 on success, 404 if no row.
 */

import { eq } from 'drizzle-orm'
import { profiles } from '@/db/schema'
import { getDb } from '@/lib/db'
import { profileBodySchema, bodyToInsert } from '../route'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Ctx = { params: Promise<{ slug: string }> }

export async function GET(_req: Request, ctx: Ctx) {
  const { slug } = await ctx.params
  try {
    const db = getDb()
    const [row] = await db.select().from(profiles).where(eq(profiles.slug, slug)).limit(1)
    if (!row) {
      return Response.json({ error: 'not_found', slug }, { status: 404 })
    }
    return Response.json({ profile: row }, { status: 200 })
  } catch (err) {
    console.error(`[api/profile/${slug}] GET failed`, err)
    return Response.json(
      { error: 'db_error', message: (err as Error).message },
      { status: 500 }
    )
  }
}

export async function PUT(req: Request, ctx: Ctx) {
  const { slug } = await ctx.params
  let body: ReturnType<typeof profileBodySchema.parse>
  try {
    const raw = (await req.json()) as unknown
    body = profileBodySchema.parse(raw)
  } catch (err) {
    return Response.json(
      { error: 'bad_request', message: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 }
    )
  }
  if (body.slug !== slug) {
    return Response.json(
      { error: 'slug_mismatch', message: `URL slug "${slug}" != body.slug "${body.slug}"` },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    const insert = bodyToInsert(body)
    // Upsert by slug. Drizzle's `onConflictDoUpdate` with `excluded.*` covers
    // the same field set as POST /api/profile.
    const [row] = await db
      .insert(profiles)
      .values(insert)
      .onConflictDoUpdate({
        target: profiles.slug,
        set: {
          name: insert.name,
          budget_min: insert.budget_min,
          budget_max: insert.budget_max,
          beds_min: insert.beds_min,
          beds_max: insert.beds_max,
          must_have: insert.must_have,
          nice_to_have: insert.nice_to_have,
          deal_breakers: insert.deal_breakers,
          vibes: insert.vibes,
          commute: insert.commute,
          preferred_areas: insert.preferred_areas,
          notes: insert.notes,
          raw_jsonb: insert.raw_jsonb as object,
        },
      })
      .returning()
    return Response.json({ profile: row }, { status: 200 })
  } catch (err) {
    console.error(`[api/profile/${slug}] PUT failed`, err)
    return Response.json(
      { error: 'db_error', message: (err as Error).message },
      { status: 500 }
    )
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { slug } = await ctx.params
  try {
    const db = getDb()
    const deleted = await db.delete(profiles).where(eq(profiles.slug, slug)).returning()
    if (deleted.length === 0) {
      return Response.json({ error: 'not_found', slug }, { status: 404 })
    }
    return new Response(null, { status: 204 })
  } catch (err) {
    console.error(`[api/profile/${slug}] DELETE failed`, err)
    return Response.json(
      { error: 'db_error', message: (err as Error).message },
      { status: 500 }
    )
  }
}
