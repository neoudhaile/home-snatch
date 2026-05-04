/**
 * Listing freshness assessment.
 *
 * Detects stale listings (posted long ago but still in the feed) and gone
 * listings (source URL is 404, has a "deleted" marker, or is otherwise
 * unreachable), and flips `is_active=false` on the gone ones.
 *
 * Each source has its own "this listing is gone" markers — Craigslist's deleted
 * page is different from Reddit's [deleted] vs Zillow's "off market" badge.
 * Markers are encoded explicitly per source; if a source isn't in the table we
 * fall back to status-code-only.
 */
import { differenceInDays, differenceInHours } from 'date-fns'
import { and, asc, eq, lt, sql } from 'drizzle-orm'
import pLimit from 'p-limit'
import { listings } from '@/db/schema'
import { getDb } from '@/lib/db'
import type { Listing, Source } from '@/types'
import { throttledFetch } from '@/scrapers/_util'

// ---------- markers ----------

/**
 * Source-specific text fragments that mean "this listing is gone". Lowercase.
 * If ANY of these appears in the response body, status = 'gone'.
 *
 * IMPORTANT: keep these conservative. Better to mark a listing 'unknown' than
 * to falsely deactivate a live one.
 */
const GONE_MARKERS: Partial<Record<Source, string[]>> = {
  craigslist: [
    'this posting has been deleted by its author',
    'this posting has expired',
    'this posting has been flagged for removal',
  ],
  reddit: [
    '[deleted]',
    '[removed]',
    'this post has been removed',
    'sorry, this post was deleted',
  ],
  'listings-project': [
    'this listing has expired',
    'this listing is no longer available',
    'no longer accepting applications',
  ],
  zillow: [
    'this home is off market',
    'this listing is no longer active',
    'no longer for rent',
    'off market',
  ],
  streeteasy: [
    'this listing is no longer available',
    'no longer listed',
    'rented',
    'this rental is off the market',
  ],
  trulia: [
    'this listing is no longer active',
    'no longer for rent',
    'off market',
  ],
  apartments: [
    'this listing is no longer available',
    'this property is no longer listed',
  ],
  manual: [],
}

// 404, 410 Gone, 451 unavailable for legal reasons → gone.
const GONE_STATUSES = new Set([404, 410, 451])

// ---------- public API ----------

export type FreshnessStatus = 'fresh' | 'stale' | 'gone' | 'unknown'

export type FreshnessAssessment = {
  status: FreshnessStatus
  reason: string
}

/**
 * Cheap freshness check based on `posted_at` and `last_seen_at`. Does NOT
 * fetch — pure function over the row. Use `refreshSingleListing` to actually
 * hit the URL.
 */
export function assessFreshness(listing: Listing): FreshnessAssessment {
  const now = new Date()
  const postedDays = listing.posted_at
    ? differenceInDays(now, listing.posted_at)
    : null
  const seenHours = differenceInHours(now, listing.last_seen_at)

  if (postedDays != null && postedDays <= 14 && seenHours <= 48) {
    return { status: 'fresh', reason: `posted ${postedDays}d ago, seen ${seenHours}h ago` }
  }
  if ((postedDays != null && postedDays > 14) || seenHours > 7 * 24) {
    return {
      status: 'stale',
      reason: `posted ${postedDays ?? 'unknown'}d ago, seen ${seenHours}h ago`,
    }
  }
  return { status: 'unknown', reason: 'no posted_at, recent last_seen_at' }
}

// ---------- network refresh ----------

type FetchOutcome = {
  status: FreshnessStatus
  reason: string
  body?: string
}

async function fetchListingPage(listing: Listing): Promise<FetchOutcome> {
  try {
    const res = await throttledFetch(listing.source_url, {
      timeoutMs: 20_000,
      // Some sites only return clean HTML when they think it's a browser
      // navigation, not a fetch. Defaults already include browser UA + Accept.
    })
    if (GONE_STATUSES.has(res.status)) {
      return { status: 'gone', reason: `HTTP ${res.status}` }
    }
    if (!res.ok) {
      return { status: 'unknown', reason: `HTTP ${res.status}` }
    }
    const body = await res.text()
    const lower = body.toLowerCase()
    const markers = GONE_MARKERS[listing.source as Source] ?? []
    for (const m of markers) {
      if (lower.includes(m)) {
        return { status: 'gone', reason: `marker: "${m}"`, body }
      }
    }
    return { status: 'fresh', reason: 'page returned 200 with no gone-marker', body }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { status: 'unknown', reason: `fetch error: ${msg}` }
  }
}

/**
 * Best-effort photo extraction so we can detect when the upstream listing
 * swapped its photo set (often the trigger for re-ranking). Just a regex over
 * `<img src=…>` and OpenGraph image tags; no full DOM parse needed.
 */
function extractPhotoUrls(body: string): string[] {
  const out = new Set<string>()
  const imgRe = /<img[^>]+src=["']([^"']+)["']/gi
  for (const m of body.matchAll(imgRe)) out.add(m[1])
  const ogRe = /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/gi
  for (const m of body.matchAll(ogRe)) out.add(m[1])
  return [...out].filter((u) => /^https?:\/\//.test(u))
}

function setEquals(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = new Set(a)
  for (const x of b) if (!sa.has(x)) return false
  return true
}

export type RefreshResult = {
  status: FreshnessStatus
  last_seen_at: Date
  photos_changed: boolean
  reason: string
}

/**
 * Hit a single listing's source URL and update its row. Marks `is_active=false`
 * on confirmed gone, refreshes `last_seen_at` on success. Returns the new
 * status so the caller (admin "refresh now" button) can show feedback.
 */
export async function refreshSingleListing(
  listing_id: string
): Promise<RefreshResult> {
  const db = getDb()
  const [row] = await db.select().from(listings).where(eq(listings.id, listing_id))
  if (!row) {
    return {
      status: 'unknown',
      last_seen_at: new Date(),
      photos_changed: false,
      reason: 'listing not found',
    }
  }
  return refreshListingRow(row as Listing)
}

async function refreshListingRow(row: Listing): Promise<RefreshResult> {
  const db = getDb()
  const outcome = await fetchListingPage(row)
  const now = new Date()

  if (outcome.status === 'gone') {
    await db
      .update(listings)
      .set({ is_active: false, last_seen_at: now })
      .where(eq(listings.id, row.id))
    return {
      status: 'gone',
      last_seen_at: now,
      photos_changed: false,
      reason: outcome.reason,
    }
  }

  if (outcome.status === 'unknown') {
    // Don't deactivate on transient errors. Just log via reason.
    return {
      status: 'unknown',
      last_seen_at: row.last_seen_at,
      photos_changed: false,
      reason: outcome.reason,
    }
  }

  // outcome.status === 'fresh'. Optionally diff photos.
  let photosChanged = false
  let nextPhotos: string[] | undefined
  if (outcome.body) {
    const candidates = extractPhotoUrls(outcome.body)
    if (candidates.length > 0 && !setEquals(candidates, row.photos ?? [])) {
      photosChanged = true
      nextPhotos = candidates.slice(0, 24)
    }
  }

  await db
    .update(listings)
    .set({
      last_seen_at: now,
      ...(nextPhotos ? { photos: nextPhotos } : {}),
    })
    .where(eq(listings.id, row.id))

  return {
    status: 'fresh',
    last_seen_at: now,
    photos_changed: photosChanged,
    reason: outcome.reason,
  }
}

export type RefreshBatchOptions = {
  /** Only check listings whose `last_seen_at` is older than this. Default 24. */
  older_than_hours?: number
  /** Cap the per-call batch. Default 50. */
  limit?: number
}

/**
 * Periodic batch refresh. Picks active listings with the oldest `last_seen_at`
 * (older than `older_than_hours`) and refreshes them, p-limit(3) so we don't
 * stampede any one host. Source-level throttling is enforced inside
 * `throttledFetch` via the per-host gate.
 */
export async function refreshStaleListings(
  opts: RefreshBatchOptions = {}
): Promise<{ checked: number; gone: number; refreshed: number }> {
  const db = getDb()
  const olderThanHours = opts.older_than_hours ?? 24
  const limit = opts.limit ?? 50

  // `last_seen_at` is non-null in the schema (defaults to now()), so a single
  // `<` predicate is enough — we don't need to NULL-check it.
  const candidates = (await db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.is_active, true),
        lt(listings.last_seen_at, sql`now() - (${olderThanHours} || ' hours')::interval`)
      )
    )
    .orderBy(asc(listings.last_seen_at))
    .limit(limit)) as Listing[]

  const gate = pLimit(3)
  let checked = 0
  let gone = 0
  let refreshed = 0
  await Promise.all(
    candidates.map((row) =>
      gate(async () => {
        const r = await refreshListingRow(row)
        checked++
        if (r.status === 'gone') gone++
        if (r.status === 'fresh') refreshed++
      })
    )
  )
  return { checked, gone, refreshed }
}
