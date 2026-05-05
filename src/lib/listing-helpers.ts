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

import { and, desc, eq, isNotNull, sql } from 'drizzle-orm'
import { differenceInHours } from 'date-fns'
import { unstable_cache } from 'next/cache'
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
import { canonicalize, expandToAliases } from '@/lib/neighborhoods'
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
 * Build the listingId -> 12mo HPD violation count map.
 *
 * Optimization: instead of pulling all ~70k hpd_violations rows over the wire
 * and running address substring matching in JS, we let Postgres do the work.
 * For each listing we generate a normalized building-level address; we then
 * issue a single SQL query that pre-filters violations whose lower(address)
 * matches any listing key (or vice versa) using ILIKE. Postgres can use a
 * functional index `(lower(address))` plus a trigram GIN index — see
 * `drizzle/extra-indexes.sql`.
 *
 * For very small listing counts (<=1) we use the bulk per-key path directly
 * since the planner picks a sensible plan. For larger sets we batch with a
 * single OR-of-ILIKEs to stay one round trip.
 *
 * Falls back gracefully on error (returns empty map).
 */
export async function buildHpdByListingId(
  listings: Pick<Listing, 'id' | 'address'>[]
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const withAddr = listings
    .map((l) => ({ id: l.id, key: normalizeAddress(l.address) }))
    .filter((l) => l.key.length > 0)
  if (withAddr.length === 0) return out

  // Build a `lower(address) ILIKE ANY ($1::text[])` candidate filter so Postgres
  // only returns rows possibly matching one of our listings. Bind the array as
  // one parameter — drizzle's tagged sql template binds nested arrays correctly
  // for postgres-js. After the SQL pre-filter we still post-process in JS to
  // also catch the inverse direction (listing key contained inside violation
  // address) which a single SQL ILIKE can't express both ways without OR.
  const patterns = Array.from(new Set(withAddr.map((l) => `%${l.key}%`)))

  const db = getDb()
  let rows: { address: string | null; count_12mo: number }[] = []
  try {
    rows = (await db
      .select({ address: hpd_violations.address, count_12mo: hpd_violations.count_12mo })
      .from(hpd_violations)
      .where(
        and(
          isNotNull(hpd_violations.address),
          sql`lower(${hpd_violations.address}) ILIKE ANY (${patterns}::text[])`,
        ),
      )) as unknown as { address: string | null; count_12mo: number }[]
  } catch {
    // Fallback: full scan with isNotNull only. Worst-case ~70k rows over wire,
    // but we only hit this path if the bound-array form fails (older PG, etc.)
    try {
      rows = await db
        .select({ address: hpd_violations.address, count_12mo: hpd_violations.count_12mo })
        .from(hpd_violations)
        .where(isNotNull(hpd_violations.address))
    } catch (err) {
      console.warn(`[listing-helpers] hpd_violations query failed: ${(err as Error).message}`)
      return out
    }
  }

  // Pre-normalize candidate violation addresses once.
  const norm = rows.map((r) => ({
    address: normalizeAddress(r.address),
    count: r.count_12mo,
  }))

  for (const l of withAddr) {
    let total = 0
    for (const v of norm) {
      if (!v.address) continue
      if (v.address === l.key || v.address.includes(l.key) || l.key.includes(v.address)) {
        total += v.count
      }
    }
    if (total > 0) out.set(l.id, total)
  }
  return out
}

/**
 * Build the listingId -> rent-stabilized boolean map. Same SQL-prefilter
 * strategy as `buildHpdByListingId`. Returns true if ANY stabilized
 * building's address matches the listing's normalized address.
 */
export async function buildRentStabByListingId(
  listings: Pick<Listing, 'id' | 'address'>[]
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>()
  const withAddr = listings
    .map((l) => ({ id: l.id, key: normalizeAddress(l.address) }))
    .filter((l) => l.key.length > 0)
  if (withAddr.length === 0) return out

  const patterns = Array.from(new Set(withAddr.map((l) => `%${l.key}%`)))

  const db = getDb()
  let rows: { address: string | null }[] = []
  try {
    rows = (await db
      .select({ address: rent_stabilized_buildings.address })
      .from(rent_stabilized_buildings)
      .where(
        and(
          isNotNull(rent_stabilized_buildings.address),
          sql`lower(${rent_stabilized_buildings.address}) ILIKE ANY (${patterns}::text[])`,
        ),
      )) as unknown as { address: string | null }[]
  } catch {
    try {
      rows = await db
        .select({ address: rent_stabilized_buildings.address })
        .from(rent_stabilized_buildings)
        .where(isNotNull(rent_stabilized_buildings.address))
    } catch (err) {
      console.warn(`[listing-helpers] rent_stabilized_buildings query failed: ${(err as Error).message}`)
      return out
    }
  }

  const norm = rows.map((r) => normalizeAddress(r.address)).filter((a) => a.length > 0)
  for (const l of withAddr) {
    const hit = norm.some((a) => a === l.key || a.includes(l.key) || l.key.includes(a))
    if (hit) out.set(l.id, true)
  }
  return out
}

// ---------- cached static reference data ----------
//
// Vibes (~262 NTAs with jsonb polygons) and subway stations (~445 rows) change
// at most once per seed run. We cache them in-process for 1 hour using the
// Next 15 unstable_cache helper. Tagged so a future re-seed step can call
// `revalidateTag('vibes')` / `revalidateTag('stations')`.
//
// ~1MB transfer for vibes is the heaviest item in the feed query — caching it
// drops getRankedFeed below 2 round trips for warm requests.

const _loadVibesUncached = async (): Promise<NeighborhoodVibe[]> => {
  const db = getDb()
  return (await db.select().from(neighborhood_vibes)) as NeighborhoodVibe[]
}

const _loadStationsUncached = async (): Promise<SubwayStation[]> => {
  const db = getDb()
  return (await db.select().from(subway_stations)) as SubwayStation[]
}

export const getCachedVibes = unstable_cache(_loadVibesUncached, ['neighborhood-vibes-v1'], {
  revalidate: 3600,
  tags: ['vibes'],
})

export const getCachedSubwayStations = unstable_cache(
  _loadStationsUncached,
  ['subway-stations-v1'],
  { revalidate: 3600, tags: ['stations'] },
)

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
  /**
   * Restrict to listings whose `neighborhood` matches one of these
   * (case-insensitive substring via SQL ILIKE ANY). Each input is expanded
   * via `expandToAliases()` so "Bed-Stuy" matches "Bedford-Stuyvesant" rows.
   * Pass an empty array or omit to skip.
   */
  neighborhoods?: string[]
  /**
   * When the `neighborhoods` filter is active, should listings whose
   * `neighborhood` column is NULL still appear? Default false — Craigslist
   * umbrella tags + Reddit posts often arrive with no neighborhood, and a
   * profile-default filter is a strict "show me my areas" intent.
   */
  includeNullNeighborhoods?: boolean
}

/**
 * Aggregate result returned alongside the ranked rows. The chip row uses this
 * to show real per-area counts (e.g. "Bed-Stuy · 25"). Counts are computed
 * over the same active+fresh+source-filtered window the feed reads from, but
 * BEFORE the neighborhoods filter — so the chip "Bushwick · 18" shows the
 * total Bushwick inventory regardless of whether the user is currently
 * filtering it out.
 */
export type NeighborhoodCounts = Record<string, number>

export type RankedFeedResult = {
  listings: RankedListing[]
  neighborhood_counts: NeighborhoodCounts
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
 *   + latest score per listing (across any profile_set_hash) — done inline via
 *     a LATERAL subquery that returns only the most recent score row, so we
 *     skip a second round trip
 *   + neighborhood_vibes (cached, PiP / name match)
 *   + nearest subway (cached, 1-NN over subway_stations)
 *   + hpd_count_12mo + rent_stabilized (SQL-prefiltered address match)
 *
 * Round trips: 1 (listings+score join) + 2 (cached vibes/stations, 0 on warm)
 *              + up to 2 (HPD, rent-stab — only if listings have addresses).
 * Was: 4 + JS-side full-table scans of HPD (~70k rows) and rent-stab.
 *
 * Order: score DESC, then posted_at DESC.
 */
export async function getRankedFeed(
  opts: RankedFeedOptions = {}
): Promise<RankedListing[]> {
  const result = await getRankedFeedWithCounts(opts)
  return result.listings
}

/**
 * Same as `getRankedFeed` but also returns per-neighborhood active-listing
 * counts (used by the chip row). Counts are computed over the active+fresh
 * window — i.e. the same population the feed itself surfaces — but BEFORE
 * the neighborhoods filter is applied, so chips show "Bushwick · 18"
 * regardless of whether Bushwick is currently selected.
 */
export async function getRankedFeedWithCounts(
  opts: RankedFeedOptions = {}
): Promise<RankedFeedResult> {
  const freshnessDays = opts.freshness_days ?? 14
  const sources = opts.sources && opts.sources.length > 0 ? opts.sources : null
  const minScore = opts.min_score ?? 0
  const limit = opts.limit ?? 200
  // Expand display names → full alias set BEFORE we generate the SQL `ILIKE
  // ANY` patterns. This is the bug fix — "Bed-Stuy" in the profile now
  // expands to ["Bedford-Stuyvesant", "Bedford Stuyvesant", "Bed-Stuy",
  // "Bed Stuy", "BedStuy", "Stuyvesant Heights", ...] and the SQL matches
  // every legacy spelling already in the column.
  const neighborhoodAliases =
    opts.neighborhoods && opts.neighborhoods.length > 0
      ? expandToAliases(opts.neighborhoods)
      : null
  const includeNullNbhd = opts.includeNullNeighborhoods === true

  const db = getDb()
  const cutoff = new Date(Date.now() - freshnessDays * 24 * 60 * 60 * 1000)

  // 1. Single round trip: listings (active+fresh+source+neighborhood) LEFT
  // JOIN LATERAL most-recent score per listing. The LATERAL form lets the
  // planner pick the top row per outer row without a window function over
  // the entire scores table. We re-cap to `limit` after JS-side enrichment
  // so the over-fetch (limit*4) compensates for any unscored rows being
  // filtered out.
  const sourceFilter = sources
    ? sql`AND l.source IN (${sql.join(sources.map((s) => sql`${s}`), sql`, `)})`
    : sql``

  // Neighborhood filter: case-insensitive substring match against
  // `listings.neighborhood`. Aliases are wrapped with `%foo%` and matched
  // with `lower(neighborhood) ILIKE ANY (...)`. We OR-in null when the
  // caller opts to keep umbrella-tagged listings.
  const nbhdMatch = neighborhoodAliases
    ? sql`lower(l.neighborhood) ILIKE ANY (${neighborhoodAliases.map(
        (n) => `%${n.toLowerCase()}%`,
      )}::text[])`
    : null
  const neighborhoodFilter = nbhdMatch
    ? includeNullNbhd
      ? sql`AND (l.neighborhood IS NULL OR ${nbhdMatch})`
      : sql`AND l.neighborhood IS NOT NULL AND ${nbhdMatch}`
    : sql``

  type JoinedRow = Listing & {
    s_listing_id: string | null
    s_profile_set_hash: string | null
    s_score: number | null
    s_headline: string | null
    s_concerns: string | null
    s_rationale_jsonb: unknown
    s_computed_at: Date | null
  }

  // Run the listings join AND the per-neighborhood count aggregate in
  // parallel. The count aggregate ignores the neighborhoods filter so the
  // chip row reflects total inventory, not "in your selection".
  type CountRow = { neighborhood: string | null; n: number }

  let joined: JoinedRow[] = []
  let countRows: CountRow[] = []
  try {
    const [j, c] = await Promise.all([
      db.execute(sql`
        SELECT l.*,
               s.listing_id        AS s_listing_id,
               s.profile_set_hash  AS s_profile_set_hash,
               s.score             AS s_score,
               s.headline          AS s_headline,
               s.concerns          AS s_concerns,
               s.rationale_jsonb   AS s_rationale_jsonb,
               s.computed_at       AS s_computed_at
        FROM listings l
        LEFT JOIN LATERAL (
          SELECT listing_id, profile_set_hash, score, headline, concerns,
                 rationale_jsonb, computed_at
          FROM scores
          WHERE listing_id = l.id
          ORDER BY computed_at DESC
          LIMIT 1
        ) s ON true
        WHERE l.is_active = true
          AND l.posted_at >= ${cutoff}
          ${sourceFilter}
          ${neighborhoodFilter}
        ORDER BY l.posted_at DESC
        LIMIT ${limit * 4}
      `) as unknown as Promise<JoinedRow[]>,
      db.execute(sql`
        SELECT l.neighborhood AS neighborhood, count(*)::int AS n
        FROM listings l
        WHERE l.is_active = true
          AND l.posted_at >= ${cutoff}
          ${sourceFilter}
        GROUP BY l.neighborhood
      `) as unknown as Promise<CountRow[]>,
    ])
    joined = j
    countRows = c
  } catch (err) {
    console.warn(`[listing-helpers] joined feed query failed: ${(err as Error).message}`)
    return { listings: [], neighborhood_counts: {} }
  }

  // Roll up counts by canonical name so "Bedford-Stuyvesant" and "Bed-Stuy"
  // and "BedStuy" all bucket together. Unknown names pass through as-is so
  // we don't lose long-tail neighborhoods.
  const neighborhood_counts: NeighborhoodCounts = {}
  for (const row of countRows) {
    if (!row.neighborhood) continue
    const canonical = canonicalize(row.neighborhood) ?? row.neighborhood
    neighborhood_counts[canonical] = (neighborhood_counts[canonical] ?? 0) + (row.n ?? 0)
  }

  if (joined.length === 0) return { listings: [], neighborhood_counts }

  // Strip the `s_*` join columns into Listing + score fields for downstream code.
  const candidates: Listing[] = joined.map((r) => {
    // postgres-js returns date/timestamp columns as Date objects; the LATERAL
    // join's NULLs come through as null. Normalize.
    return {
      ...(r as unknown as Listing),
    }
  })

  const latestByListing = new Map<string, RawScoreRow>()
  for (const r of joined) {
    if (!r.s_listing_id || r.s_score == null || !r.s_computed_at || !r.s_headline) continue
    latestByListing.set(r.s_listing_id, {
      listing_id: r.s_listing_id,
      profile_set_hash: r.s_profile_set_hash ?? '',
      score: r.s_score,
      headline: r.s_headline,
      concerns: r.s_concerns,
      rationale_jsonb: r.s_rationale_jsonb,
      computed_at: r.s_computed_at instanceof Date ? r.s_computed_at : new Date(r.s_computed_at),
    })
  }

  // 2. Cached static reference data (warm: 0 round trips).
  const [vibes, stations, hpdMap, stabMap] = await Promise.all([
    getCachedVibes(),
    getCachedSubwayStations(),
    buildHpdByListingId(candidates),
    buildRentStabByListingId(candidates),
  ])

  // 3. assemble RankedListing rows
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

  // 4. final sort: score desc, then posted_at desc
  out.sort((a, b) => {
    const ds = b.score.score - a.score.score
    if (ds !== 0) return ds
    const ap = a.posted_at?.getTime() ?? 0
    const bp = b.posted_at?.getTime() ?? 0
    return bp - ap
  })

  return {
    listings: out.slice(0, limit),
    neighborhood_counts,
  }
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

    const [vibesAll, stationsAll, hpdMap, stabMap] = await Promise.all([
      getCachedVibes(),
      getCachedSubwayStations(),
      buildHpdByListingId([listing]),
      buildRentStabByListingId([listing]),
    ])
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

  const [vibesAll, stationsAll, hpdMap, stabMap] = await Promise.all([
    getCachedVibes(),
    getCachedSubwayStations(),
    buildHpdByListingId([listing]),
    buildRentStabByListingId([listing]),
  ])

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

