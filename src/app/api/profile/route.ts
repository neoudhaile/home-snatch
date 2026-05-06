/**
 * /api/profile  —  list + create/upsert profiles.
 *
 * Body shape mirrors the on-disk profile JSON validated by `profile-set.ts`:
 *   { slug, name, budget_min?, budget_max?, beds_min?, beds_max?,
 *     must_have?, nice_to_have?, deal_breakers?, vibes?, commute?,
 *     preferred_areas?, notes? }
 *
 * `profile-set.ts` keeps its schema private to that module, so we mirror it
 * here. TODO(integrator): export `profileFileSchema` from `profile-set.ts` and
 * import it here so the contract is one-definition.
 */

import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { after } from 'next/server'
import {
  profiles,
  listings as listingsTable,
  scores as scoresTable,
  subway_stations,
} from '@/db/schema'
import { getDb } from '@/lib/db'
import { loadAllProfileFiles, clearProfileFileCache } from '@/lib/profile-set'
import { scoreListings, enqueueScoringBatch } from '@/agents/score'
import {
  hashProfileSet,
  mergeProfileConstraints,
} from '@/lib/profile-set'
import { expandToAliases } from '@/lib/neighborhoods'
import type { SubwayStation } from '@/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// Background rescore via after() needs the full Vercel Pro budget (5 min). A
// fresh-DB rescore of ~500 listings has measured at 5–10 min total; without
// this the lambda gets killed mid-flight on the platform default.
export const maxDuration = 300

const commuteEntrySchema = z.object({
  to: z.string(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  max_minutes: z.number(),
  modes: z.array(z.enum(['subway', 'walk', 'bike'])),
})

// Body schema for POST/PUT. Stricter than the on-disk schema (no FILL_ME, no
// nullable required fields) — the API is for the setup UI, which only sends
// fully-filled profiles.
const profileBodySchema = z.object({
  slug: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, 'slug must be lowercase a-z, 0-9, or -'),
  name: z.string().min(1).max(128),
  budget_min: z.number().int().nonnegative().nullable().optional(),
  budget_max: z.number().int().nonnegative().nullable().optional(),
  beds_min: z.number().nonnegative().nullable().optional(),
  beds_max: z.number().nonnegative().nullable().optional(),
  must_have: z.array(z.string()).optional(),
  nice_to_have: z.array(z.string()).optional(),
  deal_breakers: z.array(z.string()).optional(),
  vibes: z.record(z.string(), z.number()).optional(),
  commute: z.array(commuteEntrySchema).optional(),
  preferred_areas: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
})

export type ProfileBody = z.infer<typeof profileBodySchema>

function bodyToInsert(body: ProfileBody) {
  // The schema's `commute` jsonb column types lat/lng as `number | undefined`,
  // not `number | null`. Drop nulls explicitly so the insert typechecks.
  const commute = (body.commute ?? []).map((c) => {
    const out: { to: string; lat?: number; lng?: number; max_minutes: number; modes: ('subway' | 'walk' | 'bike')[] } = {
      to: c.to,
      max_minutes: c.max_minutes,
      modes: c.modes,
    }
    if (c.lat != null) out.lat = c.lat
    if (c.lng != null) out.lng = c.lng
    return out
  })

  return {
    slug: body.slug,
    name: body.name,
    budget_min: body.budget_min ?? null,
    budget_max: body.budget_max ?? null,
    // numeric() drizzle columns accept string. Coerce to keep TS happy.
    beds_min: body.beds_min != null ? String(body.beds_min) : null,
    beds_max: body.beds_max != null ? String(body.beds_max) : null,
    must_have: body.must_have ?? [],
    nice_to_have: body.nice_to_have ?? [],
    deal_breakers: body.deal_breakers ?? [],
    vibes: body.vibes ?? {},
    commute,
    preferred_areas: body.preferred_areas ?? [],
    notes: body.notes ?? null,
    raw_jsonb: body as unknown,
  }
}

export async function GET() {
  // JSON files in src/profiles/ are the source of truth. DB rows override on
  // slug clash (so the wizard's saves take precedence over the on-disk seed).
  const fileProfiles = await loadAllProfileFiles().catch((err) => {
    console.warn('[api/profile] file load failed', err)
    return [] as Array<{ slug: string; [k: string]: unknown }>
  })

  let dbRows: Array<{ slug: string; [k: string]: unknown }> = []
  try {
    const db = getDb()
    dbRows = (await db.select().from(profiles).orderBy(profiles.slug)) as typeof dbRows
  } catch (err) {
    console.warn('[api/profile] DB read failed, returning files only', err)
  }

  const merged = new Map<string, { slug: string; [k: string]: unknown }>()
  for (const p of fileProfiles) merged.set(p.slug, p)
  for (const p of dbRows) merged.set(p.slug, p)
  const out = Array.from(merged.values()).sort((a, b) => a.slug.localeCompare(b.slug))

  return Response.json({ profiles: out }, { status: 200 })
}

// The setup wizard posts `{ who, profiles: [...] }` (array). API consumers may
// post a single profile object. Accept both shapes.
const wizardBodySchema = z.object({
  who: z.union([z.number(), z.literal('all'), z.null()]).optional(),
  profiles: z.array(profileBodySchema).min(1),
})

export async function POST(req: Request) {
  let bodies: ProfileBody[]
  try {
    const raw = (await req.json()) as unknown
    const wizard = wizardBodySchema.safeParse(raw)
    if (wizard.success) {
      bodies = wizard.data.profiles
    } else {
      const single = profileBodySchema.parse(raw)
      bodies = [single]
    }
  } catch (err) {
    return Response.json(
      { error: 'bad_request', message: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 }
    )
  }

  try {
    const db = getDb()
    const saved: unknown[] = []
    for (const body of bodies) {
      const insert = bodyToInsert(body)
      const [row] = await db
        .insert(profiles)
        .values(insert)
        .onConflictDoUpdate({
          target: profiles.slug,
          set: {
            name: sql`excluded.name`,
            budget_min: sql`excluded.budget_min`,
            budget_max: sql`excluded.budget_max`,
            beds_min: sql`excluded.beds_min`,
            beds_max: sql`excluded.beds_max`,
            must_have: sql`excluded.must_have`,
            nice_to_have: sql`excluded.nice_to_have`,
            deal_breakers: sql`excluded.deal_breakers`,
            vibes: sql`excluded.vibes`,
            commute: sql`excluded.commute`,
            preferred_areas: sql`excluded.preferred_areas`,
            notes: sql`excluded.notes`,
            raw_jsonb: sql`excluded.raw_jsonb`,
          },
        })
        .returning()
      saved.push(row)
    }
    // Profiles changed → joint constraints + profile_set_hash changed → existing
    // scores are stale. Bust the feed/dq caches NOW so the next render shows the
    // re-rank, and kick off a rescore in the background (after() keeps it alive
    // past the response on Vercel).
    try {
      revalidateTag('feed', 'max')
      revalidateTag('dq', 'max')
    } catch {
      /* outside request scope when /api/profile is hit during build */
    }
    clearProfileFileCache()

    after(async () => {
      try {
        const db = getDb()
        const allListings = await db.select().from(listingsTable)
        if (allListings.length === 0) return
        const freshProfiles = await loadAllProfileFiles()
        if (freshProfiles.length === 0) return

        const joint = mergeProfileConstraints(freshProfiles)
        const profileSetHash = hashProfileSet(freshProfiles)
        const stations = (await db.select().from(subway_stations)) as SubwayStation[]

        // Split listings: eager (in any profile's preferred_areas — small,
        // user-relevant) vs the rest (large, batch-friendly).
        const aliasSet = new Set(
          expandToAliases(joint.preferred_areas).map((s) => s.toLowerCase()),
        )
        const eager: typeof allListings = []
        const rest: typeof allListings = []
        for (const l of allListings) {
          const n = (l.neighborhood ?? '').toLowerCase()
          if (n && aliasSet.has(n)) eager.push(l)
          else rest.push(l)
        }
        console.log(
          `[api/profile] split: eager=${eager.length}, batch=${rest.length}`,
        )

        // Eager: synchronous Haiku scoring. Small set, user just edited their
        // profile, they want to see preferred_areas re-ranked NOW. With the
        // Sonnet→Haiku flip this is also cheap.
        if (eager.length > 0) {
          const out = await scoreListings(eager, {
            profilesOverride: freshProfiles,
            hpdByListingId: new Map(),
            rentStabByListingId: new Map(),
            stations,
            skipAlreadyScored: false,
          })
          for (const s of out) {
            await db
              .insert(scoresTable)
              .values(s)
              .onConflictDoUpdate({
                target: [scoresTable.listing_id, scoresTable.profile_set_hash],
                set: s,
              })
          }
          try {
            revalidateTag('feed', 'max')
          } catch {
            /* ignore */
          }
          console.log(
            `[api/profile] eager rescore wrote ${out.length} preferred-area scores`,
          )
        }

        // Batch: enqueue everything else through Anthropic Batch API for the
        // 50% discount. The /api/cron/batch-poll route harvests results and
        // writes them into `scores` when the batch ends.
        if (rest.length > 0) {
          try {
            const r = await enqueueScoringBatch({
              listings: rest,
              profiles: freshProfiles,
              joint,
              profileSetHash,
              stations,
              hpdByListingId: new Map(),
              rentStabByListingId: new Map(),
            })
            console.log(
              `[api/profile] batch enqueued: id=${r.batch_id}, submitted=${r.submitted}`,
            )
          } catch (err) {
            console.warn(
              `[api/profile] batch enqueue failed, falling back to sync rescore: ${(err as Error).message}`,
            )
            // Fallback: synchronous rescore of the remainder. Keeps the user
            // unblocked even if Anthropic Batch API is down.
            const out = await scoreListings(rest, {
              profilesOverride: freshProfiles,
              hpdByListingId: new Map(),
              rentStabByListingId: new Map(),
              stations,
              skipAlreadyScored: true,
            })
            for (const s of out) {
              await db
                .insert(scoresTable)
                .values(s)
                .onConflictDoUpdate({
                  target: [scoresTable.listing_id, scoresTable.profile_set_hash],
                  set: s,
                })
            }
            try {
              revalidateTag('feed', 'max')
            } catch {
              /* ignore */
            }
            console.log(
              `[api/profile] fallback sync rescore wrote ${out.length} scores`,
            )
          }
        }
      } catch (err) {
        console.error('[api/profile] background rescore failed', err)
      }
    })

    return Response.json(
      bodies.length === 1 ? { profile: saved[0] } : { profiles: saved },
      { status: 200 }
    )
  } catch (err) {
    console.error('[api/profile] POST failed', err)
    return Response.json(
      { error: 'db_error', message: (err as Error).message },
      { status: 500 }
    )
  }
}

export { profileBodySchema, bodyToInsert }
