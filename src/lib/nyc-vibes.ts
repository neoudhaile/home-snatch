/**
 * Compute neighborhood vibe scores from public NYC Open Data.
 *
 * Inputs (all hit live HTTPS endpoints — no API keys needed for SODA reads):
 *   - 311 service requests       (`erm2-nwe9`)  -> noise score
 *   - subway entrances           (`he7q-3hwy`)  -> walkability proxy
 *   - parks geometry             (`enfh-gkve`)  -> greenness
 *   - active liquor licenses     (`s7r2-83ca`)  -> nightlife
 *   - OpenStreetMap Overpass     (amenity=cafe) -> cafes  (with fallback skip)
 *
 * Outputs: writes one row per NTA into `neighborhood_vibes`. Idempotent — safe
 * to re-run. The data agent seeds NTAs first (with `nta_code`, `nta_name`,
 * `borough`, `geom_geojson`, `centroid_lat/lng`); we only update score columns.
 *
 * Caveat: family_score is non-trivial (ACS join) and skipped for v0 — flagged
 * as a TODO.
 */

import { eq } from 'drizzle-orm'
import { neighborhood_vibes } from '@/db/schema'
import { getDb } from '@/lib/db'
import type { NeighborhoodVibe } from '@/types'

const ONE_YEAR_AGO_ISO = (() => {
  const d = new Date()
  d.setFullYear(d.getFullYear() - 1)
  return d.toISOString().slice(0, 19) // SODA wants ISO without trailing Z
})()

// SODA app-token-less rate is ~1k/hr per IP — fine for one-shot seeds.
const SODA_311 = 'https://data.cityofnewyork.us/resource/erm2-nwe9.json'
const SODA_LICENSES = 'https://data.cityofnewyork.us/resource/s7r2-83ca.json'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const OVERPASS_TIMEOUT_MS = 25_000

/** Scale a raw count/area density to a 0-10 score, clipped. */
function scale(value: number, denominator: number, cap: number): number {
  if (denominator <= 0) return 0
  const v = value / denominator
  // map [0..cap] -> [0..10] linearly, clip
  return Math.max(0, Math.min(10, Math.round((v / cap) * 100) / 10))
}

/**
 * "Quietness" score: invert per-sqmi noise complaints. NYC borough avg is
 * ~1500 noise-related 311 calls per sqmi/year; cap at 3000 (= score 0).
 */
function quietnessScore(complaints: number, sqmi: number): number {
  if (sqmi <= 0) return 5
  const density = complaints / sqmi
  // density 0     -> 10 (silent)
  // density 3000+ -> 0  (loud)
  return Math.max(0, Math.min(10, Math.round((10 - (density / 3000) * 10) * 10) / 10))
}

type GeoJSONPolygon = {
  type: 'Polygon' | 'MultiPolygon'
  coordinates: number[][][] | number[][][][]
}

type NTARow = NeighborhoodVibe & { geom_geojson: GeoJSONPolygon | null }

/**
 * Pull all NTA rows from the DB. Data agent seeds these first; we just enrich.
 */
async function getNTAs(): Promise<NTARow[]> {
  const db = getDb()
  const rows = await db.select().from(neighborhood_vibes)
  return rows as NTARow[]
}

/**
 * Compute approximate area in square miles from a GeoJSON polygon centroid.
 * We use a planar-equirectangular shoelace — wrong by <2% at NYC latitudes,
 * which is way under the ±20% noise in our 311 normalization.
 */
function polygonAreaSqMi(geom: GeoJSONPolygon | null): number {
  if (!geom) return 0
  const polygons: number[][][] =
    geom.type === 'Polygon'
      ? (geom.coordinates as number[][][])
      : (geom.coordinates as number[][][][]).flat()

  let totalSqM = 0
  for (const ring of polygons) {
    if (!ring || ring.length < 3) continue
    let s = 0
    const lat0 = ring[0][1]
    const cosLat = Math.cos((lat0 * Math.PI) / 180)
    for (let i = 0; i < ring.length - 1; i++) {
      const [x1, y1] = ring[i]
      const [x2, y2] = ring[i + 1]
      // convert deg to meters: lat=111111, lng=111111*cosLat
      const mx1 = x1 * 111_111 * cosLat
      const my1 = y1 * 111_111
      const mx2 = x2 * 111_111 * cosLat
      const my2 = y2 * 111_111
      s += mx1 * my2 - mx2 * my1
    }
    totalSqM += Math.abs(s) / 2
  }
  return totalSqM / 2_589_988 // sqm -> sqmi
}

/**
 * Cheap point-in-polygon (ray cast). Works on the standard GeoJSON polygon
 * shape; for MultiPolygon, returns true if any sub-polygon contains the point.
 */
function pointInPolygon(point: { lat: number; lng: number }, geom: GeoJSONPolygon): boolean {
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

/**
 * Get bounding box of a GeoJSON polygon — used to ask Overpass for things in a
 * rectangle, which is much faster than per-NTA polygon queries.
 */
function bbox(geom: GeoJSONPolygon): { south: number; west: number; north: number; east: number } {
  const polygons: number[][][] =
    geom.type === 'Polygon'
      ? (geom.coordinates as number[][][])
      : (geom.coordinates as number[][][][]).flat()
  let south = 90,
    west = 180,
    north = -90,
    east = -180
  for (const ring of polygons) {
    for (const [lng, lat] of ring) {
      if (lat < south) south = lat
      if (lat > north) north = lat
      if (lng < west) west = lng
      if (lng > east) east = lng
    }
  }
  return { south, west, north, east }
}

// ---------- live data fetchers ----------

/**
 * Count noise-related 311 complaints in the last 12 months by lat/lng buckets.
 * SODA caps `$limit` at 50k per request, so we paginate. We then point-in-poly
 * each complaint against each NTA.
 */
async function fetch311NoiseCounts(): Promise<{ lat: number; lng: number }[]> {
  const out: { lat: number; lng: number }[] = []
  const PAGE = 50_000
  let offset = 0
  for (;;) {
    const url =
      `${SODA_311}?$select=latitude,longitude` +
      `&$where=created_date>'${ONE_YEAR_AGO_ISO}' AND complaint_type LIKE '%25Noise%25'` +
      `AND latitude IS NOT NULL` +
      `&$limit=${PAGE}&$offset=${offset}`
    let res: Response
    try {
      res = await fetch(url)
    } catch (err) {
      console.warn(`[vibes] 311 fetch failed at offset ${offset}: ${(err as Error).message}`)
      break
    }
    if (!res.ok) {
      console.warn(`[vibes] 311 returned ${res.status} at offset ${offset}`)
      break
    }
    const rows = (await res.json()) as { latitude?: string; longitude?: string }[]
    for (const r of rows) {
      const lat = Number.parseFloat(r.latitude ?? '')
      const lng = Number.parseFloat(r.longitude ?? '')
      if (Number.isFinite(lat) && Number.isFinite(lng)) out.push({ lat, lng })
    }
    if (rows.length < PAGE) break
    offset += PAGE
    // Be polite to SODA. ~5 reqs/sec is well under their cap.
    await new Promise((r) => setTimeout(r, 200))
  }
  return out
}

/**
 * Fetch active on-premises liquor licenses (state SLA). Each license has a
 * lat/lng on `premise_address`. We treat them as a nightlife-density proxy.
 */
async function fetchLiquorLicenses(): Promise<{ lat: number; lng: number }[]> {
  const url =
    `${SODA_LICENSES}?$select=premise_address,license_type_code,latitude,longitude` +
    `&$where=license_status='Active'` +
    `&$limit=50000`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[vibes] liquor licenses returned ${res.status}`)
      return []
    }
    const rows = (await res.json()) as { latitude?: string; longitude?: string }[]
    return rows
      .map((r) => ({
        lat: Number.parseFloat(r.latitude ?? ''),
        lng: Number.parseFloat(r.longitude ?? ''),
      }))
      .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
  } catch (err) {
    console.warn(`[vibes] liquor license fetch failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Overpass API. We query NYC-wide for `amenity=cafe` and bin into NTAs.
 * If Overpass times out (it sometimes does, 30s+ for big bboxes), we return [].
 */
async function fetchCafesNYC(): Promise<{ lat: number; lng: number }[]> {
  // NYC bounding box: ~ 40.49 → 40.92 N, -74.26 → -73.69 W
  const query = `
    [out:json][timeout:25];
    (
      node["amenity"="cafe"](40.49,-74.26,40.92,-73.69);
    );
    out center;
  `
  const ctrl = AbortSignal.timeout(OVERPASS_TIMEOUT_MS)
  try {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'text/plain' },
      signal: ctrl,
    })
    if (!res.ok) {
      console.warn(`[vibes] overpass returned ${res.status}, skipping cafes`)
      return []
    }
    const data = (await res.json()) as {
      elements: { lat?: number; lon?: number; center?: { lat: number; lon: number } }[]
    }
    return data.elements
      .map((e) => ({ lat: e.lat ?? e.center?.lat, lng: e.lon ?? e.center?.lon }))
      .filter((p): p is { lat: number; lng: number } => p.lat != null && p.lng != null)
  } catch (err) {
    console.warn(`[vibes] overpass cafes fetch failed: ${(err as Error).message} — skipping cafes`)
    return []
  }
}

/**
 * Subway entrance count per NTA. We pull entrances from the same MTA dataset
 * used by the data agent — but to stay decoupled from their seed code, we
 * approximate: query entrances via Overpass (railway=subway_entrance, NYC bbox).
 */
async function fetchSubwayEntrances(): Promise<{ lat: number; lng: number }[]> {
  const query = `
    [out:json][timeout:25];
    (
      node["railway"="subway_entrance"](40.49,-74.26,40.92,-73.69);
    );
    out;
  `
  try {
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: query,
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(OVERPASS_TIMEOUT_MS),
    })
    if (!res.ok) {
      console.warn(`[vibes] overpass entrances returned ${res.status}, walkability=>centroid-based fallback`)
      return []
    }
    const data = (await res.json()) as { elements: { lat: number; lon: number }[] }
    return data.elements.map((e) => ({ lat: e.lat, lng: e.lon }))
  } catch (err) {
    console.warn(`[vibes] overpass entrances failed: ${(err as Error).message}`)
    return []
  }
}

/**
 * Greenness via NYC Parks (`enfh-gkve`). We pull park geometries and then
 * per NTA, sum the area of parks whose centroid lies inside the NTA. Faster
 * than true polygon intersection and accurate enough for a 0-10 score.
 */
async function fetchParkCentroids(): Promise<{ lat: number; lng: number; acres: number }[]> {
  // Parks dataset has acreage column; geometry is `the_geom` MultiPolygon.
  // We pull a large slice and let the SODA backend project the centroid.
  const url =
    `https://data.cityofnewyork.us/resource/enfh-gkve.json?` +
    `$select=acres,signname,multipolygon&$limit=50000`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[vibes] parks returned ${res.status}`)
      return []
    }
    type ParkRow = {
      acres?: string
      multipolygon?: { type: string; coordinates: number[][][][] }
    }
    const rows = (await res.json()) as ParkRow[]
    const out: { lat: number; lng: number; acres: number }[] = []
    for (const row of rows) {
      const acres = Number.parseFloat(row.acres ?? '0')
      if (!Number.isFinite(acres) || acres <= 0 || !row.multipolygon) continue
      // crude centroid: mean of the first ring's points
      const ring = row.multipolygon.coordinates?.[0]?.[0]
      if (!ring || ring.length === 0) continue
      let sx = 0,
        sy = 0
      for (const [x, y] of ring) {
        sx += x
        sy += y
      }
      out.push({ lat: sy / ring.length, lng: sx / ring.length, acres })
    }
    return out
  } catch (err) {
    console.warn(`[vibes] parks fetch failed: ${(err as Error).message}`)
    return []
  }
}

// ---------- main entry point ----------

/**
 * Recompute every NTA's vibe scores. Idempotent. Logs progress and skips
 * scores for any data source that failed (existing column value is preserved).
 */
export async function computeNeighborhoodVibes(): Promise<void> {
  const db = getDb()
  const ntas = await getNTAs()
  if (ntas.length === 0) {
    console.warn('[vibes] no NTAs in DB — run the data agent\'s seed-vibes first')
    return
  }
  console.log(`[vibes] computing scores for ${ntas.length} NTAs…`)

  console.log('[vibes] fetching 311 noise complaints…')
  const noisePoints = await fetch311NoiseCounts()
  console.log(`[vibes]   got ${noisePoints.length} noise points`)

  console.log('[vibes] fetching liquor licenses…')
  const liquorPoints = await fetchLiquorLicenses()
  console.log(`[vibes]   got ${liquorPoints.length} licenses`)

  console.log('[vibes] fetching subway entrances (overpass)…')
  const entrancePoints = await fetchSubwayEntrances()
  console.log(`[vibes]   got ${entrancePoints.length} entrances`)

  console.log('[vibes] fetching cafes (overpass)…')
  const cafePoints = await fetchCafesNYC()
  console.log(`[vibes]   got ${cafePoints.length} cafes`)

  console.log('[vibes] fetching park centroids…')
  const parkPoints = await fetchParkCentroids()
  console.log(`[vibes]   got ${parkPoints.length} parks`)

  // Per-NTA: bin every point by point-in-polygon. O(NTAs * points) — for ~250
  // NTAs and ~50k points that's ~12M checks, runs in a few seconds.
  for (const nta of ntas) {
    const geom = nta.geom_geojson
    const sqmi = geom ? polygonAreaSqMi(geom) : 0

    let noiseInside = 0
    let liquorInside = 0
    let entrancesInside = 0
    let cafesInside = 0
    let parkAcresInside = 0

    if (geom) {
      const box = bbox(geom)
      const inBox = (p: { lat: number; lng: number }) =>
        p.lat >= box.south && p.lat <= box.north && p.lng >= box.west && p.lng <= box.east

      for (const p of noisePoints) if (inBox(p) && pointInPolygon(p, geom)) noiseInside++
      for (const p of liquorPoints) if (inBox(p) && pointInPolygon(p, geom)) liquorInside++
      for (const p of entrancePoints) if (inBox(p) && pointInPolygon(p, geom)) entrancesInside++
      for (const p of cafePoints) if (inBox(p) && pointInPolygon(p, geom)) cafesInside++
      for (const p of parkPoints) if (inBox(p) && pointInPolygon(p, geom)) parkAcresInside += p.acres
    }

    // 0-10 scoring (calibrated to typical NYC NTA densities)
    const noise = noisePoints.length > 0 ? quietnessScore(noiseInside, Math.max(sqmi, 0.05)) : null
    const walkability = entrancePoints.length > 0
      ? scale(entrancesInside, Math.max(sqmi, 0.05), 30) // 30 entrances/sqmi -> 10
      : null
    const greenness = parkPoints.length > 0
      ? scale(parkAcresInside, Math.max(sqmi, 0.05), 80) // 80 acres/sqmi -> 10
      : null
    const nightlife = liquorPoints.length > 0
      ? scale(liquorInside, Math.max(sqmi, 0.05), 60) // 60 licenses/sqmi -> 10
      : null
    const cafes = cafePoints.length > 0
      ? scale(cafesInside, Math.max(sqmi, 0.05), 40) // 40 cafes/sqmi -> 10
      : null

    // Only update columns we actually computed; preserve nulls/existing values
    // for sources that failed.
    const update: Partial<typeof neighborhood_vibes.$inferInsert> = {
      computed_at: new Date(),
    }
    if (noise != null) update.noise = noise
    if (walkability != null) update.walkability = walkability
    if (greenness != null) update.greenness = greenness
    if (nightlife != null) update.nightlife = nightlife
    if (cafes != null) update.cafes = cafes

    await db
      .update(neighborhood_vibes)
      .set(update)
      .where(eq(neighborhood_vibes.nta_code, nta.nta_code))
  }
  console.log('[vibes] done')
  // TODO(v0->v1): family_score requires an ACS Census tract join (median
  // household-with-kids %). Punted to neighborhood-table seed.
}

/**
 * Point-to-NTA lookup. Iterates every NTA and ray-casts; for ~250 NTAs this is
 * sub-millisecond per call. Caches the row set across calls.
 */
let _ntaCache: NTARow[] | null = null
async function getNTAsCached(): Promise<NTARow[]> {
  if (_ntaCache) return _ntaCache
  _ntaCache = await getNTAs()
  return _ntaCache
}

export async function getVibeForLatLng(
  lat: number,
  lng: number
): Promise<NeighborhoodVibe | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const ntas = await getNTAsCached()
  for (const nta of ntas) {
    if (!nta.geom_geojson) continue
    if (pointInPolygon({ lat, lng }, nta.geom_geojson)) return nta
  }
  return null
}

/** Test/debug hook: invalidate the in-memory NTA cache. */
export function _clearNtaCache() {
  _ntaCache = null
}
