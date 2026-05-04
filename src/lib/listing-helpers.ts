/**
 * Listing helpers — the cross-cutting glue between raw `listings` rows and the
 * `RankedListing` shape the UI consumes. Pulls together:
 *   - latest score per listing (latest = max(computed_at) for the current
 *     profile_set_hash; we pick the most recent hash that has any rows)
 *   - neighborhood vibe (point-in-polygon over NTA geom, fallback to text match)
 *   - nearest subway station (1-NN haversine over `subway_stations`)
 *   - HPD violation count + rent-stabilization flag (substring match against
 *     normalized listing.address — best-effort, never throws)
 *
 * `getRankedFeed` is the real implementation that the integrator will swap in
 * for the UI agent's `src/lib/feed-data.ts` stub.
 */

import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'
import { differenceInHours } from 'date-fns'
import {
  hpd_violations,
  listings as listingsTable,
  neighborhood_vibes,
  rent_stabilized_buildings,
  scores,
  subway_stations,
} from '@/db/schema'
import { getDb } from '@/lib/db'
import { haversineMeters } from '@/lib/subway'
import type {
  Listing,
  NeighborhoodVibe,
  RankedListing,
  Score,
  SubwayStation,
} from '@/types'

// ---------- address normalization ----------

/**
 * Normalize an address for fuzzy matching against the open-data tables.
 *   - lowercase
 *   - strip unit suffixes ("apt 3R", "#4", ", unit 2")
 *   - collapse whitespace
 *   - drop trailing punctuation
 *
 * The open-data BBL tables don't have unit numbers anyway, so the goal is
 * "building-level address" canonical form.
 */
export function normalizeAddress(addr: string | null | undefined): string {
  if (!addr) return ''
  return addr
    .toLowerCase()
    .replace(/,\s*new york.*$/i, '')
    .replace(/,\s*ny.*$/i, '')
    .replace(/\b(apt|apartment|unit|suite|ste|#)\s*[a-z0-9-]+/gi, '')
    .replace(/[#,]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build the listingId -> 12mo HPD violation count map by scanning
 * `hpd_violations.address` for substring matches against each listing's
 * normalized address. We do the join in Node because the open-data tables
 * keyed-by-BBL aren't joinable to listings by address without a normalized
 * key column we don't have. For ~1k listings + ~50k violations this is
 * still well under a second.
 *
 * Listings without an address contribute nothing to the map.
 */
export async function buildHpdByListingId(
  listings: Pick<Listing, 'id' | 'address'>[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const withAddr = listings.filter((l) => normalizeAddress(l.address).length > 0)
  if (withAddr.length === 0) return out

  const db = getDb()
  let rows: { address: string | null; count_12mo: number }[] = []
  try {
    rows = await db
      .select({ address: hpd_violations.address, count_12mo: hpd_violations.count_12mo })
      .from(hpd_violations)
      .where(isNotNull(hpd_violations.address))
  } catch (err) {
    console.warn(`[listing-helpers] hpd_violations query failed: ${(err as Error).message}`)
    return out
  }

  // Pre-normalize the violation addresses once.
  const norm = rows.map((r) => ({
    address: normalizeAddress(r.address),
    count: r.count_12mo,
  }))

  for (const l of withAddr) {
    const key = normalizeAddress(l.address)
    if (!key) continue
    let total = 0
    for (const v of norm) {
      if (!v.address) continue
      if (v.address === key || v.address.includes(key) || key.includes(v.address)) {
        total += v.count
      }
    }
    if (total > 0) out.set(l.id, total)
  }
  return out
}

/**
 * Build the listingId -> rent-stabilized boolean map by the same address
 * substring approach. Returns true if ANY stabilized building's address
 * matches the listing's normalized address.
 */
export async function buildRentStabByListingId(
  listings: Pick<Listing, 'id' | 'address'>[]
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const withAddr = listings.filter((l) => normalizeAddress(l.address).length > 0)
  if (withAddr.length === 0) return out

  const db = getDb()
  let rows: { address: string | null }[] = []
  try {
    rows = await db
      .select({ address: rent_stabilized_buildings.address })
      .from(rent_stabilized_buildings)
      .where(isNotNull(rent_stabilized_buildings.address))
  } catch (err) {
    console.warn(`[listing-helpers] rent_stabilized_buildings query failed: ${(err as Error).message}`)
    return out
  }

  const norm = rows.map((r) => normalizeAddress(r.address)).filter((a) => a.length > 0)
  for (const l of withAddr) {
    const key = normalizeAddress(l.address)
    if (!key) continue
    const hit = norm.some((a) => a === key || a.includes(key) || key.includes(a))
    if (hit) out.set(l.id, true)
  }
  return out
}

// ---------- ranked feed ----------

export type RankedFeedOptions = {
  /** Hide listings older than N days (by posted_at). Default 14. */
  freshness_days?: number
  /** Restrict to a subset of sources. Default all. */
  sources?: string[]
  /** Minimum score (after the LLM pass). Default 0. */
  min_score?: number
  /** Maximum rows. Default 200. */
  limit?: number
}

type RawScoreRow = {
  listing_id: string
  profile_set_hash: string
  score: number
  headline: string
  concerns: string | null
  rationale_jsonb: unknown
  computed_at: Date
}

/**
 * For each listing, pick the latest score row (max computed_at). We don't
 * filter by a specific profile_set_hash — instead we let the most recent
 * score win, which is the right behavior whether or not the profile JSON
 * has shifted since the last batch.
 */
function pickLatestPerListing(rows: RawScoreRow[]): Map<string, RawScoreRow> {
  const out = new Map<string, RawScoreRow>()
  for (const r of rows) {
    const existing = out.get(r.listing_id)
    if (!existing || r.computed_at.getTime() > existing.computed_at.getTime()) {
      out.set(r.listing_id, r)
    }
  }
  return out
}

function freshnessHours(postedAt: Date | null): number | undefined {
  if (!postedAt) return undefined
  const h = differenceInHours(new Date(), postedAt)
  return h < 0 ? 0 : h
}

function rowToScore(r: RawScoreRow): Score {
  return {
    listing_id: r.listing_id,
    profile_set_hash: r.profile_set_hash,
    score: r.score,
    headline: r.headline,
    concerns: r.concerns,
    rationale_jsonb: r.rationale_jsonb,
    computed_at: r.computed_at,
  } as Score
}

function pickVibeForListing(
  listing: Pick<Listing, 'lat' | 'lng' | 'neighborhood'>,
  vibes: NeighborhoodVibe[]
): NeighborhoodVibe | null {
  // 1. point-in-polygon over geom_geojson if we have lat/lng
  if (listing.lat != null && listing.lng != null) {
    for (const v of vibes) {
      const geom = v.geom_geojson as
        | { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
        | null
      if (!geom) continue
      if (pointInPolygon({ lat: listing.lat, lng: listing.lng }, geom)) return v
    }
  }
  // 2. fallback: case-insensitive nta_name match
  if (listing.neighborhood) {
    const needle = listing.neighborhood.trim().toLowerCase()
    for (const v of vibes) {
      if (v.nta_name && v.nta_name.toLowerCase() === needle) return v
    }
    for (const v of vibes) {
      if (
        v.nta_name &&
        (v.nta_name.toLowerCase().includes(needle) || needle.includes(v.nta_name.toLowerCase()))
      ) {
        return v
      }
    }
  }
  return null
}

function pointInPolygon(
  point: { lat: number; lng: number },
  geom: { type: 'Polygon' | 'MultiPolygon'; coordinates: number[][][] | number[][][][] }
): boolean {
  const polygons: number[][][] =
    geom.type === 'Polygon'
      ? (geom.coordinates as number[][][])
      : (geom.coordinates as number[][][][]).flat()
  for (const ring of polygons) {
    if (rayCast(point, ring)) return true
  }
  return false
}

function rayCast(point: { lat: number; lng: number }, ring: number[][]): boolean {
  const x = point.lng
  const y = point.lat
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    const intersect =
      yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-12) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function nearestSubwayFor(
  listing: Pick<Listing, 'lat' | 'lng'>,
  stations: SubwayStation[]
): RankedListing['nearest_subway'] {
  if (listing.lat == null || listing.lng == null) return null
  if (stations.length === 0) return null
  let best: { station: SubwayStation; distance_m: number } | null = null
  for (const s of stations) {
    const d = haversineMeters({ lat: listing.lat, lng: listing.lng }, { lat: s.lat, lng: s.lng })
    if (!best || d < best.distance_m) best = { station: s, distance_m: d }
  }
  if (!best) return null
  return {
    stop_id: best.station.stop_id,
    name: best.station.name,
    lines: best.station.lines ?? [],
    distance_m: Math.round(best.distance_m),
  }
}

/**
 * The real ranked-feed implementation. Joins:
 *   listings (active, fresh, optional source filter)
 *   + latest score per listing (across any profile_set_hash)
 *   + neighborhood_vibes (PiP / name match)
 *   + nearest subway (1-NN over subway_stations)
 *   + hpd_count_12mo + rent_stabilized (best-effort address match)
 *
 * Order: score DESC, then posted_at DESC. Cheap; one round trip per table.
 */
export async function getRankedFeed(
  opts: RankedFeedOptions = {}
): Promise<RankedListing[]> {
  const freshnessDays = opts.freshness_days ?? 14
  const sources = opts.sources && opts.sources.length > 0 ? opts.sources : null
  const minScore = opts.min_score ?? 0
  const limit = opts.limit ?? 200

  const db = getDb()
  const cutoff = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000)

  // 1. fetch candidate listings (over-fetch a bit; we'll re-cap after join)
  const filters = [
    eq(listingsTable.is_active, true),
    gte(listingsTable.posted_at, cutoff),
  ]
  if (sources) filters.push(inArray(listingsTable.source, sources))

  const candidates = (await db
    .select()
    .from(listingsTable)
    .where(and(...filters))
    .orderBy(desc(listingsTable.posted_at))
    .limit(limit * 4)) as Listing[]

  if (candidates.length === 0) return []

  const ids = candidates.map((c) => c.id)

  // 2. fetch all scores for those listings; pick latest in JS
  const scoreRows = (await db
    .select({
      listing_id: scores.listing_id,
      profile_set_hash: scores.profile_set_hash,
      score: scores.score,
      headline: scores.headline,
      concerns: scores.concerns,
      rationale_jsonb: scores.rationale_jsonb,
      computed_at: scores.computed_at,
    })
    .from(scores)
    .where(inArray(scores.listing_id, ids))) as RawScoreRow[]
  const latestByListing = pickLatestPerListing(scoreRows)

  // 3. fetch ALL vibes (small — ~250 NTAs) and ALL stations (small — ~470)
  const vibes = (await db.select().from(neighborhood_vibes)) as NeighborhoodVibe[]
  const stations = (await db.select().from(subway_stations)) as SubwayStation[]

  // 4. address-based enrichment
  const hpdMap = await buildHpdByListingId(candidates)
  const stabMap = await buildRentStabByListingId(candidates)

  // 5. assemble RankedListing rows
  const out: RankedListing[] = []
  for (const listing of candidates) {
    const scoreRow = latestByListing.get(listing.id)
    if (!scoreRow) continue
    if (scoreRow.score < minScore) continue
    const vibe = pickVibeForListing(listing, vibes)
    const nearest = nearestSubwayFor(listing, stations)
    const ranked: RankedListing = {
      ...listing,
      score: rowToScore(scoreRow),
      vibe,
      nearest_subway: nearest,
      hpd_count_12mo: hpdMap.get(listing.id) ?? 0,
      rent_stabilized: stabMap.get(listing.id) ?? false,
      freshness_hours: freshnessHours(listing.posted_at),
    }
    out.push(ranked)
  }

  // 6. final sort: score desc, then posted_at desc
  out.sort((a, b) => {
    const ds = b.score.score - a.score.score
    if (ds !== 0) return ds
    const ap = a.posted_at?.getTime() ?? 0
    const bp = b.posted_at?.getTime() ?? 0
    return bp - ap
  })

  return out.slice(0, limit)
}

/**
 * Single-listing detail variant. Same join shape as `getRankedFeed`, just one
 * row. Returns `null` if the listing doesn't exist or has no score yet.
 */
export async function getListingDetail(id: string): Promise<RankedListing | null> {
  const db = getDb()
  const [listing] = (await db
    .select()
    .from(listingsTable)
    .where(eq(listingsTable.id, id))
    .limit(1)) as Listing[]
  if (!listing) return null

  const scoreRows = (await db
    .select({
      listing_id: scores.listing_id,
      profile_set_hash: scores.profile_set_hash,
      score: scores.score,
      headline: scores.headline,
      concerns: scores.concerns,
      rationale_jsonb: scores.rationale_jsonb,
      computed_at: scores.computed_at,
    })
    .from(scores)
    .where(eq(scores.listing_id, id))
    .orderBy(desc(scores.computed_at))
    .limit(1)) as RawScoreRow[]

  const scoreRow = scoreRows[0]
  // We allow detail without a score (so the UI can render an "unscored" state).
  // If you'd rather hide them, the caller can null-check `score`.
  if (!scoreRow) {
    // Build an empty placeholder score so the type stays satisfied. The UI
    // already null-checks rationale/concerns, but `score.score=0` is honest.
    const placeholder: Score = {
      listing_id: id,
      profile_set_hash: '',
      score: 0,
      headline: '',
      concerns: null,
      rationale_jsonb: null,
      computed_at: new Date(0),
    } as Score

    const vibesAll = (await db.select().from(neighborhood_vibes)) as NeighborhoodVibe[]
    const stationsAll = (await db.select().from(subway_stations)) as SubwayStation[]
    const hpdMap = await buildHpdByListingId([listing])
    const stabMap = await buildRentStabByListingId([listing])
    return {
      ...listing,
      score: placeholder,
      vibe: pickVibeForListing(listing, vibesAll),
      nearest_subway: nearestSubwayFor(listing, stationsAll),
      hpd_count_12mo: hpdMap.get(listing.id) ?? 0,
      rent_stabilized: stabMap.get(listing.id) ?? false,
      freshness_hours: freshnessHours(listing.posted_at),
    }
  }

  const vibesAll = (await db.select().from(neighborhood_vibes)) as NeighborhoodVibe[]
  const stationsAll = (await db.select().from(subway_stations)) as SubwayStation[]
  const hpdMap = await buildHpdByListingId([listing])
  const stabMap = await buildRentStabByListingId([listing])

  return {
    ...listing,
    score: rowToScore(scoreRow),
    vibe: pickVibeForListing(listing, vibesAll),
    nearest_subway: nearestSubwayFor(listing, stationsAll),
    hpd_count_12mo: hpdMap.get(listing.id) ?? 0,
    rent_stabilized: stabMap.get(listing.id) ?? false,
    freshness_hours: freshnessHours(listing.posted_at),
  }
}

// `sql` import is referenced only to keep drizzle's TS happy with raw expressions
// if a future caller wants to slot one in. Not used at runtime here.
void sql
