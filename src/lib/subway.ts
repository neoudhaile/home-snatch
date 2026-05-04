import type { SubwayStation } from '@/types'

export type LatLng = { lat: number; lng: number }

const EARTH_RADIUS_M = 6_371_000
const WALK_SPEED_M_PER_MIN = 80 // ~3 mph, normal NYC walk
const AVG_SECONDS_PER_STOP = 120 // 2 min/stop on the same line
const TRANSFER_PENALTY_MIN = 5

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/**
 * Great-circle distance between two lat/lng points, in meters.
 * Standard haversine — accurate enough for "walk to nearest station".
 */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

export function nearestStation(
  point: LatLng,
  stations: SubwayStation[]
): { station: SubwayStation; distance_m: number } | null {
  if (stations.length === 0) return null
  let best: { station: SubwayStation; distance_m: number } | null = null
  for (const s of stations) {
    const d = haversineMeters(point, { lat: s.lat, lng: s.lng })
    if (!best || d < best.distance_m) best = { station: s, distance_m: d }
  }
  return best
}

/** Walking minutes to the nearest station, assuming WALK_SPEED_M_PER_MIN. */
export function walkMinutesToNearest(point: LatLng, stations: SubwayStation[]): number {
  const nearest = nearestStation(point, stations)
  if (!nearest) return Number.POSITIVE_INFINITY
  return nearest.distance_m / WALK_SPEED_M_PER_MIN
}

/**
 * Crude commute estimate. NOT google-maps-accurate; we just need precision good
 * enough for a rationale line ("≈25 min on the F, 1 transfer").
 *
 * Algorithm:
 *   1. walk to nearest station to `from`
 *   2. walk-equivalent ride to nearest station to `to`
 *   3. transit minutes = haversine_km(from_station, to_station) / km_per_stop * AVG_SECONDS_PER_STOP
 *      where km_per_stop ≈ 0.8km (rough NYC inter-stop spacing)
 *   4. if from_station and to_station share no lines, add TRANSFER_PENALTY_MIN
 *      (we're not routing, just penalizing the case where lines don't overlap)
 *
 * Returns null if either point is unstationable (no stations within ~5km).
 */
export function commuteEstimate(
  from: LatLng,
  to: LatLng,
  stations: SubwayStation[]
): {
  walk_min: number
  transit_min: number
  total_min: number
  transfers: number
  from_station_name: string | null
  to_station_name: string | null
  shared_lines: string[]
} | null {
  const fromNearest = nearestStation(from, stations)
  const toNearest = nearestStation(to, stations)
  if (!fromNearest || !toNearest) return null

  // Reject pathological cases — if either side is >5km from any station, we're
  // guessing too hard.
  if (fromNearest.distance_m > 5_000 || toNearest.distance_m > 5_000) return null

  const walkFromMin = fromNearest.distance_m / WALK_SPEED_M_PER_MIN
  const walkToMin = toNearest.distance_m / WALK_SPEED_M_PER_MIN

  const interStationM = haversineMeters(
    { lat: fromNearest.station.lat, lng: fromNearest.station.lng },
    { lat: toNearest.station.lat, lng: toNearest.station.lng }
  )
  // approximate stops between: NYC inter-stop spacing ~ 800m
  const stops = Math.max(1, Math.round(interStationM / 800))
  const fromLines = new Set(fromNearest.station.lines ?? [])
  const toLines = new Set(toNearest.station.lines ?? [])
  const shared = [...fromLines].filter((l) => toLines.has(l))
  const transfers = shared.length > 0 ? 0 : 1
  const transitMin = (stops * AVG_SECONDS_PER_STOP) / 60 + transfers * TRANSFER_PENALTY_MIN

  const total = walkFromMin + transitMin + walkToMin

  return {
    walk_min: round1(walkFromMin + walkToMin),
    transit_min: round1(transitMin),
    total_min: round1(total),
    transfers,
    from_station_name: fromNearest.station.name,
    to_station_name: toNearest.station.name,
    shared_lines: shared,
  }
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}
