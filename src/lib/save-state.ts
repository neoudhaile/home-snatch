/**
 * Save state. The read/write surface for the `saved_listings` table.
 *
 * Strategy: try Postgres first (Drizzle, via getDb). If DATABASE_URL isn't set
 * we fall back to a process-local in-memory store that's deliberately seeded
 * with a few demo entries from the mock feed. This keeps /saved + /compare
 * useful at design time when the DB hasn't been wired yet, and the same code
 * path runs for prod.
 *
 * No `saved_at` writes go to the mock store from the API; those calls error
 * if the DB is unavailable, which is the right behavior for a real save.
 *
 * Profile set is dynamic: who counts as a "saver" comes from the JSON files
 * under src/profiles/. The lib trusts its callers — the API routes validate
 * incoming `saved_by` values against `isValidSaver()` before we land here.
 */

import { eq, and, inArray, desc } from 'drizzle-orm'
import { listings, scores, neighborhood_vibes, saved_listings } from '@/db/schema'
import type { RankedListing } from '@/types'
import { getRankedFeed, getListing } from '@/lib/feed-data'
import { getKnownSavers } from '@/lib/profile-set'

/** A saver slug. Just a string — runtime validation lives in `isValidSaver`. */
export type Saver = string

/**
 * Server-side: the list of known saver slugs, sourced from src/profiles/.
 * Always returns a fresh read so adding a profile JSON doesn't require a
 * server restart.
 */
export async function getSavers(): Promise<string[]> {
  return getKnownSavers()
}

/**
 * Process-local mock store. Seeded with a handful of listing IDs so design-time
 * /saved and /compare have content. Never persisted across process restarts.
 *
 * The seed is keyed by the canonical pair of profiles (inaan + makonnen) just
 * for design-time content. It still works fine when those slugs don't exist
 * (the data simply doesn't surface), and works fine when other slugs exist
 * (their lists are empty).
 */
type MockEntry = { listing_id: string; saved_by: Saver; saved_at: Date }
const mockSeed: MockEntry[] = [
  // Both saved (intersection: the headline of /saved)
  { listing_id: 'a1f0c000-0000-4000-8000-000000000001', saved_by: 'inaan', saved_at: new Date(Date.now() - 6 * 60 * 60 * 1000) },
  { listing_id: 'a1f0c000-0000-4000-8000-000000000001', saved_by: 'makonnen', saved_at: new Date(Date.now() - 5 * 60 * 60 * 1000) },
  { listing_id: 'a1f0c000-0000-4000-8000-000000000012', saved_by: 'inaan', saved_at: new Date(Date.now() - 30 * 60 * 1000) },
  { listing_id: 'a1f0c000-0000-4000-8000-000000000012', saved_by: 'makonnen', saved_at: new Date(Date.now() - 90 * 60 * 1000) },
  // First-saver-only seed
  { listing_id: 'a1f0c000-0000-4000-8000-000000000002', saved_by: 'inaan', saved_at: new Date(Date.now() - 2 * 60 * 60 * 1000) },
  { listing_id: 'a1f0c000-0000-4000-8000-000000000010', saved_by: 'inaan', saved_at: new Date(Date.now() - 22 * 60 * 60 * 1000) },
  // Second-saver-only seed
  { listing_id: 'a1f0c000-0000-4000-8000-000000000004', saved_by: 'makonnen', saved_at: new Date(Date.now() - 4 * 60 * 60 * 1000) },
]

// Globally cached mock store across hot reloads in dev.
declare global {
  // eslint-disable-next-line no-var
  var __homesnatch_saved_mock__: MockEntry[] | undefined
}
function getMockStore(): MockEntry[] {
  if (!globalThis.__homesnatch_saved_mock__) {
    globalThis.__homesnatch_saved_mock__ = [...mockSeed]
  }
  return globalThis.__homesnatch_saved_mock__
}

/** True iff the DB connection is configured. */
function hasDb(): boolean {
  return typeof process.env.DATABASE_URL === 'string' && process.env.DATABASE_URL.length > 0
}

async function tryDb<T>(work: () => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
  if (!hasDb()) return await fallback()
  try {
    return await work()
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn('[save-state] DB call failed, falling back to mock:', (err as Error).message)
    }
    return await fallback()
  }
}

/* ---------------------- reads ---------------------- */

/**
 * RankedListing for one or more listing IDs, in the order requested. Anything
 * that can't be resolved is skipped (no `null` placeholders). Tries DB first,
 * falls back to the mock feed.
 */
async function loadRankedByIds(ids: string[]): Promise<RankedListing[]> {
  if (ids.length === 0) return []

  return tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db
        .select({
          listing: listings,
          score: scores,
          vibe: neighborhood_vibes,
        })
        .from(listings)
        .leftJoin(scores, eq(scores.listing_id, listings.id))
        .leftJoin(neighborhood_vibes, eq(neighborhood_vibes.borough, listings.borough))
        .where(inArray(listings.id, ids))

      const map = new Map<string, RankedListing>()
      for (const r of rows) {
        if (!r.score) continue
        map.set(r.listing.id, {
          ...r.listing,
          score: r.score,
          vibe: r.vibe ?? null,
        } as RankedListing)
      }
      return ids.map((id) => map.get(id)).filter(Boolean) as RankedListing[]
    },
    async () => {
      const out: RankedListing[] = []
      for (const id of ids) {
        const found = await getListing(id)
        if (found) out.push(found)
      }
      return out
    },
  )
}

/**
 * All listings saved by a given saver, most-recently-saved first.
 */
export async function getSavedFor(saver: Saver): Promise<RankedListing[]> {
  const ordered = await tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db
        .select({ listing_id: saved_listings.listing_id, saved_at: saved_listings.saved_at })
        .from(saved_listings)
        .where(eq(saved_listings.saved_by, saver))
        .orderBy(desc(saved_listings.saved_at))
      return rows.map((r) => r.listing_id)
    },
    () => {
      const store = getMockStore()
      return store
        .filter((e) => e.saved_by === saver)
        .sort((a, b) => b.saved_at.getTime() - a.saved_at.getTime())
        .map((e) => e.listing_id)
    },
  )
  return loadRankedByIds(ordered)
}

/**
 * Listings ALL known savers have saved. Sorted by joint score DESC. This is
 * the decision-relevant headline of /saved.
 */
export async function getSavedIntersection(): Promise<RankedListing[]> {
  const knownSavers = await getKnownSavers()
  const knownSet = new Set(knownSavers)

  const sharedIds = await tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db
        .select({ listing_id: saved_listings.listing_id, saved_by: saved_listings.saved_by })
        .from(saved_listings)
      const bySaver = new Map<string, Set<Saver>>()
      for (const r of rows) {
        if (!knownSet.has(r.saved_by)) continue
        const set = bySaver.get(r.listing_id) ?? new Set<Saver>()
        set.add(r.saved_by)
        bySaver.set(r.listing_id, set)
      }
      return [...bySaver.entries()]
        .filter(([, savers]) => savers.size === knownSavers.length && knownSavers.length > 0)
        .map(([id]) => id)
    },
    () => {
      const store = getMockStore()
      const bySaver = new Map<string, Set<Saver>>()
      for (const e of store) {
        if (!knownSet.has(e.saved_by)) continue
        const set = bySaver.get(e.listing_id) ?? new Set<Saver>()
        set.add(e.saved_by)
        bySaver.set(e.listing_id, set)
      }
      return [...bySaver.entries()]
        .filter(([, savers]) => savers.size === knownSavers.length && knownSavers.length > 0)
        .map(([id]) => id)
    },
  )
  const ranked = await loadRankedByIds(sharedIds)
  ranked.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
  return ranked
}

/**
 * For each listing ID, who's saved it. Used by feed/listing-detail to render
 * heart state. Empty arrays are returned for unsaved IDs.
 */
export async function getSaveStateForListings(
  ids: string[],
): Promise<Record<string, Saver[]>> {
  const out: Record<string, Saver[]> = Object.fromEntries(ids.map((id) => [id, []]))
  if (ids.length === 0) return out

  const knownSet = new Set(await getKnownSavers())

  await tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db
        .select({ listing_id: saved_listings.listing_id, saved_by: saved_listings.saved_by })
        .from(saved_listings)
        .where(inArray(saved_listings.listing_id, ids))
      for (const r of rows) {
        if (!knownSet.has(r.saved_by)) continue
        if (!out[r.listing_id]) out[r.listing_id] = []
        out[r.listing_id].push(r.saved_by)
      }
    },
    () => {
      const store = getMockStore()
      for (const e of store) {
        if (!knownSet.has(e.saved_by)) continue
        if (!out[e.listing_id]) continue
        out[e.listing_id].push(e.saved_by)
      }
    },
  )
  return out
}

/**
 * Total count across all savers (for the header pill). Cheap.
 */
export async function getTotalSavedCount(): Promise<number> {
  return tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db.select({ id: saved_listings.listing_id }).from(saved_listings)
      const unique = new Set(rows.map((r) => r.id))
      return unique.size
    },
    () => {
      const store = getMockStore()
      return new Set(store.map((e) => e.listing_id)).size
    },
  )
}

/* ---------------------- writes ---------------------- */

export async function saveListing(listing_id: string, saver: Saver): Promise<void> {
  if (hasDb()) {
    const { getDb } = await import('@/lib/db')
    const db = getDb()
    await db
      .insert(saved_listings)
      .values({ listing_id, saved_by: saver })
      .onConflictDoNothing()
    return
  }
  const store = getMockStore()
  if (!store.some((e) => e.listing_id === listing_id && e.saved_by === saver)) {
    store.push({ listing_id, saved_by: saver, saved_at: new Date() })
  }
}

export async function unsaveListing(listing_id: string, saver: Saver): Promise<void> {
  if (hasDb()) {
    const { getDb } = await import('@/lib/db')
    const db = getDb()
    await db
      .delete(saved_listings)
      .where(
        and(eq(saved_listings.listing_id, listing_id), eq(saved_listings.saved_by, saver)),
      )
    return
  }
  const store = getMockStore()
  const idx = store.findIndex((e) => e.listing_id === listing_id && e.saved_by === saver)
  if (idx >= 0) store.splice(idx, 1)
}

/* ---------------------- helpers used by /compare ---------------------- */

/**
 * Read profile JSONs for commute targets. Defensive: this is for display only,
 * so we tolerate FILL_ME placeholders and just hide rows we can't resolve.
 */
export type CommuteTarget = { saver: Saver; label: string }

export async function getCommuteTargets(): Promise<CommuteTarget[]> {
  try {
    const { readFile } = await import('node:fs/promises')
    const { join } = await import('node:path')
    const dir = join(process.cwd(), 'src', 'profiles')
    const out: CommuteTarget[] = []
    const savers = await getKnownSavers()
    for (const saver of savers) {
      try {
        const raw = await readFile(join(dir, `${saver}.json`), 'utf8')
        const json = JSON.parse(raw) as { commute?: Array<{ to?: string }> }
        const first = json.commute?.[0]?.to
        if (first && !first.includes('FILL_ME')) {
          out.push({ saver, label: first })
        }
      } catch {
        // skip unreadable / missing profile
      }
    }
    return out
  } catch {
    return []
  }
}

/**
 * Pull saver chips for a set of listings (used by /compare's "Saved by" row).
 */
export async function getSaversByListing(ids: string[]): Promise<Record<string, Saver[]>> {
  return getSaveStateForListings(ids)
}

/**
 * Same as `getSavedFor` but returns the saved_at instant alongside, used by
 * the feed integrator if they want recency-driven UI.
 */
export async function getSavedTimestamps(saver: Saver): Promise<Record<string, Date>> {
  return tryDb(
    async () => {
      const { getDb } = await import('@/lib/db')
      const db = getDb()
      const rows = await db
        .select({ listing_id: saved_listings.listing_id, saved_at: saved_listings.saved_at })
        .from(saved_listings)
        .where(eq(saved_listings.saved_by, saver))
      const out: Record<string, Date> = {}
      for (const r of rows) out[r.listing_id] = r.saved_at
      return out
    },
    () => {
      const store = getMockStore()
      const out: Record<string, Date> = {}
      for (const e of store) {
        if (e.saved_by !== saver) continue
        out[e.listing_id] = e.saved_at
      }
      return out
    },
  )
}

/**
 * Re-export for callers who just want the full feed (used by /saved
 * "add another" flow when picking new listings to drop into compare).
 */
export { getRankedFeed }
