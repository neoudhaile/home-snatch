/**
 * Seed NYC Open Data into the local Postgres.
 *
 * Datasets (Socrata JSON, no auth required):
 *   - Subway stations            `i7jb-7jku`
 *   - Subway entrances           `hvnk-aabd` (skipped — we only persist stations)
 *   - HPD violations             `wvxf-dwi5`  (filter last 12 months, group by BBL)
 *   - Rent-stabilized buildings  `tdrx-mwj7`  (~50k rows; bulk insert)
 *   - NTA polygons               `9nt8-h7nd`  (Neighborhood Tabulation Areas)
 *
 * Idempotency: every upsert uses `onConflictDoUpdate` against the table's
 * unique key so re-running the seed never duplicates.
 */

import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import {
  hpd_violations,
  neighborhood_vibes,
  rent_stabilized_buildings,
  subway_stations,
} from '@/db/schema'

const SOCRATA = 'https://data.cityofnewyork.us/resource'
const SOCRATA_NY = 'https://data.ny.gov/resource'

/** Page through a Socrata JSON endpoint with $limit/$offset. */
async function socrataQuery<T>(
  dataset: string,
  params: Record<string, string | number> = {},
  pageSize = 5_000,
  host: string = SOCRATA
): Promise<T[]> {
  const out: T[] = []
  let offset = 0
  // Hard cap at 200k rows per dataset to avoid runaway pagination.
  const HARD_CAP = 200_000
  while (offset < HARD_CAP) {
    const qs = new URLSearchParams({
      $limit: String(pageSize),
      $offset: String(offset),
      ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
    })
    const url = `${host}/${dataset}.json?${qs.toString()}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Socrata ${dataset} HTTP ${res.status}`)
    const batch = (await res.json()) as T[]
    if (!Array.isArray(batch) || batch.length === 0) break
    out.push(...batch)
    if (batch.length < pageSize) break
    offset += pageSize
  }
  return out
}

// ---- subway stations ----

type SubwayStationRow = {
  gtfs_stop_id?: string
  gtfs_stop_ids?: string  // 5f5g-n3cz uses plural (comma-sep for complexes)
  stop_id?: string
  stop_name?: string
  display_name?: string
  latitude?: string
  longitude?: string
  name?: string
  gtfs_latitude?: string
  gtfs_longitude?: string
  stop_lat?: string
  stop_lon?: string
  daytime_routes?: string
  routes?: string
}

async function seedSubwayStations() {
  const db = getDb()
  // MTA Subway Stations live on data.ny.gov (NY State Open Data). Dataset
  // 5f5g-n3cz ("MTA Subway Stations and Complexes") returns ~445 rows with
  // gtfs_stop_ids (comma-sep for station complexes — take the first), stop_name,
  // latitude, longitude, daytime_routes (space-sep line letters), borough.
  // The earlier alternate 39hk-dx4f returns only 1 row in the public API
  // (deprecated / stub) — do not use.
  const rows = await socrataQuery<SubwayStationRow>('5f5g-n3cz', {}, 5_000, SOCRATA_NY)
  const records = rows
    .map((r) => {
      const stop_id =
        r.gtfs_stop_ids?.split(',')[0]?.trim() ?? r.gtfs_stop_id ?? r.stop_id
      const name = r.stop_name ?? r.display_name ?? r.name
      const lat = parseFloat(r.latitude ?? r.gtfs_latitude ?? r.stop_lat ?? '')
      const lng = parseFloat(r.longitude ?? r.gtfs_longitude ?? r.stop_lon ?? '')
      const linesStr = r.daytime_routes ?? r.routes ?? ''
      if (!stop_id || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
      return {
        stop_id,
        name,
        lat,
        lng,
        lines: linesStr.split(/\s+/).filter(Boolean),
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)

  if (records.length === 0) {
    console.log('[seed] subway: 0 rows')
    return
  }

  // Drizzle's pg insert handles batching, but we chunk to keep statements small.
  const CHUNK = 500
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK)
    await db
      .insert(subway_stations)
      .values(batch)
      .onConflictDoUpdate({
        target: subway_stations.stop_id,
        set: {
          name: sql`excluded.name`,
          lat: sql`excluded.lat`,
          lng: sql`excluded.lng`,
          lines: sql`excluded.lines`,
        },
      })
  }
  console.log(`[seed] subway: ${records.length} rows`)
}

// ---- HPD violations ----

type HpdRow = {
  bbl?: string
  housenumber?: string
  streetname?: string
  inspectiondate?: string
}

async function seedHpdViolations() {
  const db = getDb()
  const since = new Date()
  since.setMonth(since.getMonth() - 12)
  const sinceISO = since.toISOString().slice(0, 19) // Socrata FLOATING_TIMESTAMP
  const rows = await socrataQuery<HpdRow>('wvxf-dwi5', {
    $where: `inspectiondate >= '${sinceISO}'`,
    $select: 'bbl,housenumber,streetname,inspectiondate',
  })
  type Agg = { count_12mo: number; address: string | null; last_seen: Date | null }
  const byBbl = new Map<string, Agg>()
  for (const r of rows) {
    if (!r.bbl) continue
    const cur = byBbl.get(r.bbl) ?? { count_12mo: 0, address: null, last_seen: null }
    cur.count_12mo += 1
    if (!cur.address && r.housenumber && r.streetname) {
      cur.address = `${r.housenumber} ${r.streetname}`.trim()
    }
    const ts = r.inspectiondate ? new Date(r.inspectiondate) : null
    if (ts && (!cur.last_seen || ts > cur.last_seen)) cur.last_seen = ts
    byBbl.set(r.bbl, cur)
  }
  const records = [...byBbl.entries()].map(([bbl, agg]) => ({
    bbl,
    address: agg.address,
    count_12mo: agg.count_12mo,
    last_seen: agg.last_seen,
  }))
  if (records.length === 0) {
    console.log('[seed] hpd: 0 rows')
    return
  }
  const CHUNK = 1000
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK)
    await db
      .insert(hpd_violations)
      .values(batch)
      .onConflictDoUpdate({
        target: hpd_violations.bbl,
        set: {
          address: sql`excluded.address`,
          count_12mo: sql`excluded.count_12mo`,
          last_seen: sql`excluded.last_seen`,
        },
      })
  }
  console.log(`[seed] hpd: ${records.length} rows`)
}

// ---- rent-stabilized buildings ----

type RsbRow = {
  bbl?: string
  ucbbl?: string
  address?: string
  street1?: string
  street2?: string
  units?: string
  unitcount?: string
}

async function seedRentStabilized() {
  const db = getDb()
  // The NYC HCR rent-stabilized building list is NOT publicly hosted as a clean
  // dataset on data.cityofnewyork.us — `tdrx-mwj7` is stale (404). The community
  // standard (used by Streeteasy/JustFix) is JustFix's `taxbills.nyc` archive,
  // but it's not Socrata-shaped. For v0 we skip cleanly and HPD violations
  // remain the primary public-data quality signal. Re-enable when a usable
  // public dataset appears or when we add a JustFix-archive importer.
  console.log('[seed] rent_stabilized: skipped (no current public dataset)')
  return
  const rows = await socrataQuery<RsbRow>('tdrx-mwj7', {})
  const records = rows
    .map((r) => {
      const bbl = r.bbl ?? r.ucbbl
      if (!bbl) return null
      const address =
        r.address ??
        ([r.street1, r.street2].filter(Boolean).join(', ') || null)
      const unitsStr = r.units ?? r.unitcount
      const units = unitsStr ? parseInt(unitsStr, 10) : null
      return {
        bbl,
        address,
        units: Number.isFinite(units as number) ? (units as number) : null,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)
  if (records.length === 0) {
    console.log('[seed] rent_stabilized: 0 rows')
    return
  }
  const CHUNK = 1000
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK)
    await db
      .insert(rent_stabilized_buildings)
      .values(batch)
      .onConflictDoUpdate({
        target: rent_stabilized_buildings.bbl,
        set: {
          address: sql`excluded.address`,
          units: sql`excluded.units`,
        },
      })
  }
  console.log(`[seed] rent_stabilized: ${records.length} rows`)
}

// ---- Neighborhood Tabulation Areas ----

type NtaRow = {
  nta2020?: string
  ntacode?: string
  ntaname?: string
  nta_name?: string
  boroname?: string
  borough?: string
  the_geom?: { type: string; coordinates: unknown } | string
  geometry?: unknown
}

async function seedNtaPolygons() {
  const db = getDb()
  const rows = await socrataQuery<NtaRow>('9nt8-h7nd', {})
  const records = rows
    .map((r) => {
      const code = r.nta2020 ?? r.ntacode
      const name = r.ntaname ?? r.nta_name
      const borough = r.boroname ?? r.borough ?? ''
      if (!code || !name) return null
      let geom_geojson: unknown = null
      if (typeof r.the_geom === 'object' && r.the_geom) geom_geojson = r.the_geom
      else if (r.geometry) geom_geojson = r.geometry
      // Centroid: the polygon is a MultiPolygon; we leave centroid null and the
      // scoring agent computes it (or the seed-vibes pass does). Cheap centroid
      // from the first ring's average is a fine fallback.
      let centroid_lat: number | null = null
      let centroid_lng: number | null = null
      if (
        geom_geojson &&
        typeof geom_geojson === 'object' &&
        'coordinates' in (geom_geojson as Record<string, unknown>)
      ) {
        const coords = (geom_geojson as { coordinates: unknown }).coordinates
        const ring = firstRing(coords)
        if (ring && ring.length > 0) {
          let sx = 0
          let sy = 0
          for (const [x, y] of ring) {
            sx += x
            sy += y
          }
          centroid_lng = sx / ring.length
          centroid_lat = sy / ring.length
        }
      }
      return {
        nta_code: code,
        nta_name: name,
        borough,
        geom_geojson,
        centroid_lat,
        centroid_lng,
      }
    })
    .filter((r): r is NonNullable<typeof r> => r != null)
  if (records.length === 0) {
    console.log('[seed] nta: 0 rows')
    return
  }
  const CHUNK = 200
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK)
    await db
      .insert(neighborhood_vibes)
      .values(batch)
      .onConflictDoUpdate({
        target: neighborhood_vibes.nta_code,
        set: {
          nta_name: sql`excluded.nta_name`,
          borough: sql`excluded.borough`,
          geom_geojson: sql`excluded.geom_geojson`,
          centroid_lat: sql`excluded.centroid_lat`,
          centroid_lng: sql`excluded.centroid_lng`,
        },
      })
  }
  console.log(`[seed] nta: ${records.length} rows`)
}

/** Walk a GeoJSON coordinates structure (Polygon|MultiPolygon) to its first linear ring. */
function firstRing(coords: unknown): Array<[number, number]> | null {
  if (!Array.isArray(coords)) return null
  // MultiPolygon: [ [ [ [x,y], ... ] ] ]
  // Polygon:      [ [ [x,y], ... ] ]
  let cur: unknown = coords
  for (let depth = 0; depth < 4; depth++) {
    if (
      Array.isArray(cur) &&
      cur.length > 0 &&
      Array.isArray((cur as unknown[])[0]) &&
      (cur as unknown[][])[0].length === 2 &&
      typeof (cur as number[][])[0][0] === 'number'
    ) {
      return cur as Array<[number, number]>
    }
    if (Array.isArray(cur) && cur.length > 0) cur = (cur as unknown[])[0]
    else return null
  }
  return null
}

/** Top-level seed entrypoint. Each step is independent; failures are logged. */
export async function seedNycOpenData() {
  const steps: Array<[string, () => Promise<void>]> = [
    ['subway', seedSubwayStations],
    ['hpd', seedHpdViolations],
    ['rent_stabilized', seedRentStabilized],
    ['nta', seedNtaPolygons],
  ]
  for (const [name, fn] of steps) {
    try {
      await fn()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[seed] ${name} failed: ${msg}`)
    }
  }
}
