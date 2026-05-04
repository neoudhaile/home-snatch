/**
 * Listing dedupe.
 *
 * Detects when the same physical apartment is listed on multiple sources (e.g.
 * Zillow + StreetEasy + Craigslist for the same unit) and consolidates to ONE
 * canonical entry the user sees in the feed. Duplicate rows stay in the DB
 * (`is_active=false`, `raw.canonical_id` set) so the canonical card can show
 * "also listed on N other sites" without losing provenance.
 *
 * Quality bar:
 *   FALSE POSITIVES ARE WORSE THAN FALSE NEGATIVES. Better to leave two true
 *   duplicates split than to merge two distinct apartments. We require the
 *   bucket key (price ±$50, beds, borough) AND at least 2 of {address-match,
 *   lat/lng within 30m, photo URL overlap, title Jaccard ≥0.6} before treating
 *   a pair as a duplicate.
 *
 * Canonical pick rule: source priority list (richer-data sites first), with
 * `posted_at` desc as tiebreaker.
 */
import { and, eq, sql } from 'drizzle-orm'
import { listings } from '@/db/schema'
import { getDb } from '@/lib/db'
import type { Listing, Source } from '@/types'

// ---------- tunables ----------

/** Lower index = higher priority (preferred as canonical). */
const SOURCE_PRIORITY: Source[] = [
  'zillow',
  'streeteasy',
  'listings-project',
  'trulia',
  'apartments',
  'craigslist',
  'reddit',
  'manual',
]

/** Price bucket half-width in dollars. Two listings within ±$50 share a bucket. */
const PRICE_BUCKET = 50

/** Two listings within this many meters are a "same building" candidate. */
const LATLNG_METERS = 30

/** Title Jaccard threshold for "probable same listing". */
const TITLE_JACCARD = 0.6

/** Minimum number of corroborating signals required to call a pair duplicate. */
const MIN_SIGNALS = 2

// ---------- public types ----------

export type DupeCluster = {
  canonical: Listing
  dupes: Listing[]
}

// ---------- normalization ----------

const STREET_TYPE_RE =
  /\b(street|st|avenue|ave|av|road|rd|boulevard|blvd|place|pl|drive|dr|lane|ln|terrace|ter|court|ct|parkway|pkwy)\b\.?/g
const UNIT_RE = /\b(apt|unit|#|suite|ste)\s*[\w-]+/g
const PUNCT_RE = /[.,#]/g

function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return ''
  return addr
    .toLowerCase()
    .replace(UNIT_RE, ' ')
    .replace(STREET_TYPE_RE, ' ')
    .replace(PUNCT_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set()
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3)
  )
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** Equirectangular meters. Good enough at NYC latitudes. */
function distanceMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number }
): number {
  const R = 6_371_000
  const lat1 = (a.lat * Math.PI) / 180
  const lat2 = (b.lat * Math.PI) / 180
  const dLat = lat2 - lat1
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const x = dLng * Math.cos((lat1 + lat2) / 2)
  return Math.sqrt(x * x + dLat * dLat) * R
}

/**
 * Strip query strings off photo URLs; many sites cache-bust with `?v=` per
 * source even when the upstream image is the same byte-for-byte.
 */
function photoFingerprint(url: string): string {
  try {
    const u = new URL(url)
    return `${u.host}${u.pathname}`.toLowerCase()
  } catch {
    return url.toLowerCase()
  }
}

function priceBucket(p: number | null): number | null {
  if (p == null) return null
  return Math.round(p / PRICE_BUCKET)
}

function bucketKey(l: Listing): string | null {
  const pb = priceBucket(l.price_monthly)
  if (pb == null) return null
  if (!l.beds) return null
  if (!l.borough) return null
  return `${pb}::${l.beds}::${l.borough.toLowerCase()}`
}

// ---------- pair scoring ----------

type PairSignals = {
  addressMatch: boolean
  latLngClose: boolean
  photoOverlap: boolean
  titleSimilar: boolean
}

function scorePair(a: Listing, b: Listing): PairSignals {
  const aAddr = normalizeAddress(a.address)
  const bAddr = normalizeAddress(b.address)
  const addressMatch = aAddr.length > 0 && aAddr === bAddr

  let latLngClose = false
  if (a.lat != null && a.lng != null && b.lat != null && b.lng != null) {
    const d = distanceMeters(
      { lat: a.lat, lng: a.lng },
      { lat: b.lat, lng: b.lng }
    )
    latLngClose = d <= LATLNG_METERS
  }

  const aPhotos = new Set((a.photos ?? []).map(photoFingerprint))
  const bPhotos = new Set((b.photos ?? []).map(photoFingerprint))
  let photoOverlap = false
  for (const fp of aPhotos) {
    if (bPhotos.has(fp)) {
      photoOverlap = true
      break
    }
  }

  const titleSimilar =
    jaccard(tokens(a.title), tokens(b.title)) >= TITLE_JACCARD &&
    !!a.neighborhood &&
    a.neighborhood.toLowerCase() === (b.neighborhood ?? '').toLowerCase()

  return { addressMatch, latLngClose, photoOverlap, titleSimilar }
}

function countSignals(s: PairSignals): number {
  return (
    (s.addressMatch ? 1 : 0) +
    (s.latLngClose ? 1 : 0) +
    (s.photoOverlap ? 1 : 0) +
    (s.titleSimilar ? 1 : 0)
  )
}

// ---------- canonical pick ----------

function sourceRank(src: string): number {
  const i = SOURCE_PRIORITY.indexOf(src as Source)
  return i === -1 ? SOURCE_PRIORITY.length : i
}

function pickCanonical(group: Listing[]): Listing {
  return [...group].sort((a, b) => {
    const r = sourceRank(a.source) - sourceRank(b.source)
    if (r !== 0) return r
    const at = a.posted_at ? a.posted_at.getTime() : 0
    const bt = b.posted_at ? b.posted_at.getTime() : 0
    return bt - at
  })[0]
}

// ---------- public API ----------

/**
 * Pure dedupe pass. Returns one cluster per canonical listing; clusters with no
 * duplicates are still returned (callers can filter on `dupes.length > 0`).
 */
export function findDuplicates(input: Listing[]): DupeCluster[] {
  // Bucket by price/beds/borough.
  const buckets = new Map<string, Listing[]>()
  for (const l of input) {
    const key = bucketKey(l)
    if (!key) continue
    const arr = buckets.get(key) ?? []
    arr.push(l)
    buckets.set(key, arr)
  }

  // Union-find within each bucket.
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let p = parent.get(x) ?? x
    if (p === x) return x
    const r = find(p)
    parent.set(x, r)
    return r
  }
  const union = (a: string, b: string) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent.set(ra, rb)
  }
  for (const l of input) parent.set(l.id, l.id)

  for (const group of buckets.values()) {
    if (group.length < 2) continue
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sigs = scorePair(group[i], group[j])
        if (countSignals(sigs) >= MIN_SIGNALS) {
          union(group[i].id, group[j].id)
        }
      }
    }
  }

  // Walk the disjoint sets back into clusters.
  const clusters = new Map<string, Listing[]>()
  for (const l of input) {
    const root = find(l.id)
    const arr = clusters.get(root) ?? []
    arr.push(l)
    clusters.set(root, arr)
  }

  const out: DupeCluster[] = []
  for (const group of clusters.values()) {
    if (group.length === 0) continue
    const canonical = pickCanonical(group)
    const dupes = group.filter((g) => g.id !== canonical.id)
    out.push({ canonical, dupes })
  }
  return out
}

/**
 * Run the dedupe pass against every active listing in the DB. Sets duplicates
 * to `is_active=false` and writes the canonical's id into the dupe's
 * `raw.canonical_id` for traceability. Idempotent — runs against the canonical
 * still active each time.
 */
export async function markDuplicates(): Promise<{
  canonicals: number
  deduped: number
}> {
  const db = getDb()
  const active = await db
    .select()
    .from(listings)
    .where(eq(listings.is_active, true))

  const clusters = findDuplicates(active as Listing[])

  let canonicals = 0
  let deduped = 0
  for (const cluster of clusters) {
    if (cluster.dupes.length === 0) continue
    canonicals++
    for (const d of cluster.dupes) {
      // Merge canonical_id into existing raw blob so we don't trample upstream
      // structured data.
      const merged: Record<string, unknown> =
        d.raw && typeof d.raw === 'object' && !Array.isArray(d.raw)
          ? { ...(d.raw as Record<string, unknown>) }
          : d.raw != null
            ? { upstream: d.raw }
            : {}
      merged.canonical_id = cluster.canonical.id
      merged.canonical_source = cluster.canonical.source

      await db
        .update(listings)
        .set({ is_active: false, raw: merged })
        .where(and(eq(listings.id, d.id), eq(listings.is_active, true)))
      deduped++
    }
  }
  return { canonicals, deduped }
}

/**
 * Read-only helper: count canonicals that have ≥1 active dupe in their cluster.
 * Used by the DQ dashboard. Pure DB query (no LLM, no scrape).
 */
export async function countDuplicateClusters(): Promise<number> {
  const db = getDb()
  // Count rows where raw.canonical_id is set AND is_active=false (i.e. already
  // marked as a dupe). Group by canonical_id, count distinct canonicals.
  const rows = await db.execute<{ canonical_id: string }>(sql`
    SELECT DISTINCT raw->>'canonical_id' AS canonical_id
    FROM listings
    WHERE is_active = false
      AND raw->>'canonical_id' IS NOT NULL
  `)
  return rows.length
}
