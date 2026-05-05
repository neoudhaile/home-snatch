import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type { Profile } from '@/types'

/**
 * Zod schema for the on-disk profile JSON. Mirrors the DB shape but with
 * everything-nullable up front so we can detect the FILL_ME-still-present case
 * and skip those files cleanly.
 */
const commuteEntrySchema = z.object({
  to: z.string().nullable().optional(),
  lat: z.number().nullable().optional(),
  lng: z.number().nullable().optional(),
  max_minutes: z.number().nullable().optional(),
  modes: z.array(z.enum(['subway', 'walk', 'bike'])).optional(),
})

const profileFileSchema = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  budget_min: z.number().int().nullable().optional(),
  budget_max: z.number().int().nullable().optional(),
  beds_min: z.number().nullable().optional(),
  beds_max: z.number().nullable().optional(),
  must_have: z.array(z.string()).optional(),
  nice_to_have: z.array(z.string()).optional(),
  deal_breakers: z.array(z.string()).optional(),
  vibes: z.record(z.string(), z.number().nullable()).optional(),
  commute: z.array(commuteEntrySchema).optional(),
  preferred_areas: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
})

export type ProfileFile = z.infer<typeof profileFileSchema>

/**
 * A merged constraint object we hand to pre-match + scoring. All fields are
 * derived from every profile in the set. `vibes` only contains keys present
 * in every profile (so we don't pretend one person's "quiet=7" is a joint
 * preference if another person never weighed in).
 */
export type JointConstraints = {
  budget_min: number | null
  budget_max: number | null
  beds_min: number | null
  beds_max: number | null
  must_have: string[]
  nice_to_have: string[]
  deal_breakers: string[]
  /** elementwise mean across all profiles, only over keys defined everywhere */
  vibes: Record<string, number>
  preferred_areas: string[]
  /** the most-restrictive (smallest) max_minutes among the joint commute targets */
  commute_targets: {
    to: string
    lat: number | null
    lng: number | null
    max_minutes: number
    modes: ('subway' | 'walk' | 'bike')[]
  }[]
  /** which profile slugs participated in this set */
  profile_slugs: string[]
}

const FILL_ME = 'FILL_ME'

function hasFillMe(value: unknown): boolean {
  if (typeof value === 'string') return value.includes(FILL_ME)
  if (Array.isArray(value)) return value.some(hasFillMe)
  if (value && typeof value === 'object') return Object.values(value).some(hasFillMe)
  return false
}

function isProfileReady(p: ProfileFile): boolean {
  // A profile is "ready" if its required-for-joint fields are concrete (no FILL_ME, non-null
  // budget_max, at least one of must_have/deal_breakers/preferred_areas defined).
  if (p.budget_max == null) return false
  if (hasFillMe(p.must_have ?? [])) return false
  if (hasFillMe(p.deal_breakers ?? [])) return false
  if (hasFillMe(p.preferred_areas ?? [])) return false
  if (hasFillMe(p.commute ?? [])) return false
  return true
}

/**
 * SHA-256 of a stable string, truncated to 16 hex chars. Stable means: sorted
 * by slug, sorted lists, sorted vibe keys + values, every ranking-affecting
 * field included. Same profiles -> same hash, period.
 *
 * Hashes EVERY field that affects ranking so that any meaningful edit (vibe
 * value change, preferred_areas tweak, commute target adjustment, etc.) flips
 * the hash and triggers a rescore on the next save.
 */
export function hashProfileSet(profiles: ProfileFile[]): string {
  const stableJson = profiles
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((p) =>
      JSON.stringify({
        slug: p.slug,
        budget_min: p.budget_min ?? null,
        budget_max: p.budget_max ?? null,
        beds_min: p.beds_min ?? null,
        beds_max: p.beds_max ?? null,
        must_have: [...(p.must_have ?? [])].sort(),
        nice_to_have: [...(p.nice_to_have ?? [])].sort(),
        deal_breakers: [...(p.deal_breakers ?? [])].sort(),
        vibes: Object.fromEntries(
          Object.entries(p.vibes ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        ),
        preferred_areas: [...(p.preferred_areas ?? [])].sort(),
        commute: (p.commute ?? [])
          .map((c) => ({ to: c.to ?? '', max_minutes: c.max_minutes ?? null }))
          .sort((a, b) => a.to.localeCompare(b.to)),
      }),
    )
    .join('|')
  return createHash('sha256').update(stableJson).digest('hex').slice(0, 16)
}

/**
 * Read profiles from the `profiles` DB table and normalize to the in-memory
 * ProfileFile shape every consumer expects. Returns `null` on hard failure
 * (no DATABASE_URL, query throws). Returns `[]` if the table exists but is
 * empty — callers treat both empty-table and hard-fail as "fall back to
 * JSON files".
 *
 * Drizzle returns `numeric()` columns as `string`; we coerce to number.
 */
async function _loadFromDbUncached(): Promise<ProfileFile[] | null> {
  if (!process.env.DATABASE_URL) return null
  try {
    // Lazy import so unit-tests / build-time code paths that never touch the
    // DB don't pay the cost of constructing the connection pool.
    const { getDb } = await import('@/lib/db')
    const { profiles: profilesTable } = await import('@/db/schema')
    const db = getDb()
    const rows = await db.select().from(profilesTable)
    const out: ProfileFile[] = []
    for (const r of rows) {
      const pf: ProfileFile = {
        slug: r.slug,
        name: r.name,
        budget_min: r.budget_min ?? null,
        budget_max: r.budget_max ?? null,
        beds_min: r.beds_min != null ? Number(r.beds_min) : null,
        beds_max: r.beds_max != null ? Number(r.beds_max) : null,
        must_have: (r.must_have ?? []) as string[],
        nice_to_have: (r.nice_to_have ?? []) as string[],
        deal_breakers: (r.deal_breakers ?? []) as string[],
        vibes: (r.vibes ?? {}) as Record<string, number | null>,
        commute: ((r.commute ?? []) as Array<{
          to?: string | null
          lat?: number | null
          lng?: number | null
          max_minutes?: number | null
          modes?: ('subway' | 'walk' | 'bike')[]
        }>).map((c) => ({
          to: c.to ?? null,
          lat: c.lat ?? null,
          lng: c.lng ?? null,
          max_minutes: c.max_minutes ?? null,
          modes: c.modes ?? undefined,
        })),
        preferred_areas: (r.preferred_areas ?? []) as string[],
        notes: r.notes ?? null,
      }
      out.push(pf)
    }
    out.sort((a, b) => a.slug.localeCompare(b.slug))
    return out
  } catch (err) {
    console.warn('[profile-set] DB load failed, will fall back to files:', (err as Error).message)
    return null
  }
}

// In-memory cache of parsed profile rows (from DB). Same 60s TTL as the file
// cache. Keyed by a sentinel string since DB has no per-directory parameter.
type DbCacheEntry = { at: number; data: ProfileFile[] | null }
const _profileDbCache = new Map<string, DbCacheEntry>()
const DB_CACHE_KEY = '__db__'

async function loadFromDb(): Promise<ProfileFile[] | null> {
  const now = Date.now()
  const hit = _profileDbCache.get(DB_CACHE_KEY)
  if (hit && now - hit.at < PROFILE_CACHE_TTL_MS) return hit.data
  const data = await _loadFromDbUncached()
  _profileDbCache.set(DB_CACHE_KEY, { at: now, data })
  return data
}

/**
 * Read every JSON file under src/profiles/, validate, and return the ones
 * that are filled in. Files containing FILL_ME for any required field are
 * dropped with a console.warn — we never mix half-filled profiles into the
 * joint constraints, that path leads to silent garbage.
 *
 * DB-first: tries the `profiles` table first; falls back to JSON files when
 * the table is empty or unavailable. Used by scoring + chat tooling.
 */
export async function loadProfilesFromJson(
  profilesDir = join(process.cwd(), 'src', 'profiles')
): Promise<ProfileFile[]> {
  const all = await loadAllProfileFiles(profilesDir)
  const out: ProfileFile[] = []
  for (const parsed of all) {
    if (!isProfileReady(parsed)) {
      // We log once per stale-cache-cycle on the underlying loader; staying
      // quiet here so we don't spam the console on the cached path.
      continue
    }
    out.push(parsed)
  }
  return out
}

// In-memory cache of parsed profile files keyed by directory. Profiles are
// edited via the JSON-files-as-config workflow — they change at most a few
// times during a session. A 60s TTL eliminates the FS reads from every page
// render / API call while still picking up edits within ~1 min. Not using
// `unstable_cache` because Next's data cache doesn't share state with raw
// Node FS reads cleanly across HMR boundaries in dev.
type ProfileCacheEntry = { at: number; data: ProfileFile[] }
const _profileFileCache = new Map<string, ProfileCacheEntry>()
const PROFILE_CACHE_TTL_MS = 60_000

/**
 * Internal: bypass the cache. Used only by the cached wrapper below.
 */
async function _loadAllProfileFilesUncached(profilesDir: string): Promise<ProfileFile[]> {
  let files: string[]
  try {
    files = await readdir(profilesDir)
  } catch (err) {
    console.warn(`[profile-set] could not read ${profilesDir}: ${(err as Error).message}`)
    return []
  }

  const out: ProfileFile[] = []
  for (const file of files.filter((f) => f.endsWith('.json'))) {
    const path = join(profilesDir, file)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = profileFileSchema.parse(JSON.parse(raw))
      out.push(parsed)
    } catch (err) {
      console.warn(`[profile-set] failed to parse ${file}: ${(err as Error).message}`)
    }
  }
  // Sort alphabetically by slug for deterministic ordering across the app.
  out.sort((a, b) => a.slug.localeCompare(b.slug))
  return out
}

async function _loadFromFiles(profilesDir: string): Promise<ProfileFile[]> {
  const now = Date.now()
  const hit = _profileFileCache.get(profilesDir)
  if (hit && now - hit.at < PROFILE_CACHE_TTL_MS) return hit.data
  const data = await _loadAllProfileFilesUncached(profilesDir)
  _profileFileCache.set(profilesDir, { at: now, data })
  return data
}

/**
 * Canonical loader: returns every known profile, regardless of "ready" state.
 * This is the canonical list of *known* profile slugs/names — the one
 * referenced by the saver/UI surface so a half-filled profile still shows up
 * as a saver.
 *
 * DB-first behavior:
 *   1. Try the `profiles` table. If ≥1 row, return those (normalized).
 *   2. If 0 rows OR DB error: fall back to JSON files under `src/profiles/`.
 *      Useful for fresh installs and read-only build artifacts on Vercel
 *      where the JSONs are baked into the build but the wizard writes the DB.
 *
 * Both paths are cached in-process for 60s. Server-side only; uses fs + DB.
 */
export async function loadAllProfileFiles(
  profilesDir = join(process.cwd(), 'src', 'profiles')
): Promise<ProfileFile[]> {
  const fromDb = await loadFromDb()
  if (fromDb && fromDb.length > 0) return fromDb
  return _loadFromFiles(profilesDir)
}

/**
 * Force-reload profiles from disk + DB on next call. Clears BOTH caches. Used
 * after the wizard writes a new profile so subsequent reads reflect the
 * change without the 60-second wait.
 */
export function clearProfileFileCache(): void {
  _profileFileCache.clear()
  _profileDbCache.clear()
}

/**
 * Known saver slugs, derived from the merged DB-or-files set.
 * Server-side only.
 */
export async function getKnownSavers(
  profilesDir = join(process.cwd(), 'src', 'profiles')
): Promise<string[]> {
  const profiles = await loadAllProfileFiles(profilesDir)
  return profiles.map((p) => p.slug)
}

/**
 * Map of slug -> display name. Server-side only.
 */
export async function getProfileNames(
  profilesDir = join(process.cwd(), 'src', 'profiles')
): Promise<Record<string, string>> {
  const profiles = await loadAllProfileFiles(profilesDir)
  const out: Record<string, string> = {}
  for (const p of profiles) out[p.slug] = p.name
  return out
}

/**
 * Runtime validation: is `slug` a known saver? Server-side only.
 */
export async function isValidSaver(
  slug: string,
  profilesDir = join(process.cwd(), 'src', 'profiles')
): Promise<boolean> {
  if (typeof slug !== 'string' || slug.length === 0) return false
  const slugs = await getKnownSavers(profilesDir)
  return slugs.includes(slug)
}

/**
 * Render a list of names with English-style joining.
 *   1 → "Alice"
 *   2 → "Alice and Bob"
 *   3+ → "Alice, Bob, and Carol"   (Oxford comma)
 */
export function joinProfileNames(names: string[]): string {
  if (names.length === 0) return ''
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}`
}

function uniq(xs: string[]): string[] {
  return Array.from(new Set(xs.map((s) => s.trim()).filter((s) => s.length > 0)))
}

/**
 * Merge N profiles into a single joint constraint set:
 *   - budget_max = min (so we don't propose listings either profile rejects)
 *   - budget_min = max (the more-demanding floor wins)
 *   - beds = intersection of [min,max] ranges
 *   - must_have / deal_breakers / preferred_areas = union (anyone's must_have is a must_have)
 *   - vibes = elementwise mean over keys present in every profile; keys missing
 *     from anyone are dropped (no fake consensus)
 *   - commute_targets = all targets, with concrete max_minutes only
 */
export function mergeProfileConstraints(profiles: ProfileFile[]): JointConstraints {
  if (profiles.length === 0) {
    return {
      budget_min: null,
      budget_max: null,
      beds_min: null,
      beds_max: null,
      must_have: [],
      nice_to_have: [],
      deal_breakers: [],
      vibes: {},
      preferred_areas: [],
      commute_targets: [],
      profile_slugs: [],
    }
  }

  const budgetMaxes = profiles.map((p) => p.budget_max).filter((v): v is number => v != null)
  const budgetMins = profiles.map((p) => p.budget_min).filter((v): v is number => v != null)
  const bedsMins = profiles.map((p) => p.beds_min).filter((v): v is number => v != null)
  const bedsMaxes = profiles.map((p) => p.beds_max).filter((v): v is number => v != null)

  const must = uniq(profiles.flatMap((p) => p.must_have ?? []))
  const nice = uniq(profiles.flatMap((p) => p.nice_to_have ?? []))
  const breakers = uniq(profiles.flatMap((p) => p.deal_breakers ?? []))
  const areas = uniq(profiles.flatMap((p) => p.preferred_areas ?? []))

  // Vibes: only keys that ALL profiles have a numeric (non-null) value for.
  const everyoneVibes: Record<string, number>[] = profiles.map((p) => {
    const out: Record<string, number> = {}
    for (const [k, v] of Object.entries(p.vibes ?? {})) {
      if (typeof v === 'number') out[k] = v
    }
    return out
  })
  const sharedVibeKeys = Object.keys(everyoneVibes[0] ?? {}).filter((k) =>
    everyoneVibes.every((v) => k in v)
  )
  const vibes: Record<string, number> = {}
  for (const k of sharedVibeKeys) {
    const vals = everyoneVibes.map((v) => v[k])
    vibes[k] = vals.reduce((a, b) => a + b, 0) / vals.length
  }

  // Commute: pull every target with concrete max_minutes; dedupe on `to` taking
  // the smallest max_minutes (most-restrictive).
  const commuteByTo = new Map<string, JointConstraints['commute_targets'][number]>()
  for (const p of profiles) {
    for (const c of p.commute ?? []) {
      if (!c.to || c.to.includes(FILL_ME) || c.max_minutes == null) continue
      const existing = commuteByTo.get(c.to)
      const candidate = {
        to: c.to,
        lat: c.lat ?? null,
        lng: c.lng ?? null,
        max_minutes: c.max_minutes,
        modes: c.modes ?? ['subway', 'walk'],
      }
      if (!existing || candidate.max_minutes < existing.max_minutes) {
        commuteByTo.set(c.to, candidate)
      }
    }
  }

  return {
    budget_min: budgetMins.length ? Math.max(...budgetMins) : null,
    budget_max: budgetMaxes.length ? Math.min(...budgetMaxes) : null,
    beds_min: bedsMins.length ? Math.max(...bedsMins) : null,
    beds_max: bedsMaxes.length ? Math.min(...bedsMaxes) : null,
    must_have: must,
    nice_to_have: nice,
    deal_breakers: breakers,
    vibes,
    preferred_areas: areas,
    commute_targets: Array.from(commuteByTo.values()),
    profile_slugs: profiles.map((p) => p.slug).sort(),
  }
}

/**
 * Convenience: same as `Profile` from the DB, but the DB-only fields aren't
 * required. Most callers want the joint constraints anyway, but the score agent
 * still wants the raw per-profile vibes vector for prompt context.
 */
export function profileFileToProfilePartial(p: ProfileFile): Pick<Profile,
  'slug' | 'name' | 'budget_min' | 'budget_max' | 'must_have' | 'nice_to_have' | 'deal_breakers' | 'preferred_areas' | 'notes'
> & { vibes: Record<string, number> } {
  const vibes: Record<string, number> = {}
  for (const [k, v] of Object.entries(p.vibes ?? {})) {
    if (typeof v === 'number') vibes[k] = v
  }
  return {
    slug: p.slug,
    name: p.name,
    budget_min: p.budget_min ?? null,
    budget_max: p.budget_max ?? null,
    must_have: p.must_have ?? [],
    nice_to_have: p.nice_to_have ?? [],
    deal_breakers: p.deal_breakers ?? [],
    preferred_areas: p.preferred_areas ?? [],
    notes: p.notes ?? null,
    vibes,
  }
}
