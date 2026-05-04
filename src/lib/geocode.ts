/**
 * Address & neighborhood geocoding.
 *
 * Two paths:
 *   1. geocodeAddress(addr)        - hits OpenStreetMap Nominatim. Rate-limited
 *                                    to 1 req/sec (their TOS), in-memory cached.
 *   2. geocodeNeighborhood(name)   - hardcoded NYC neighborhood centroid LUT.
 *                                    Use this when the listing only has a
 *                                    neighborhood string (Craigslist, Reddit).
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search'
const USER_AGENT = 'homesnatch/0.1 (personal use)'
const NOMINATIM_MIN_INTERVAL_MS = 1_100 // 1 req/sec, with a small safety margin

export type GeocodeHit = {
  lat: number
  lng: number
  neighborhood: string | null
  borough: string | null
}

const cache = new Map<string, GeocodeHit | null>()

let lastRequestAt = 0

function normalizeAddress(addr: string): string {
  return addr.trim().toLowerCase().replace(/\s+/g, ' ')
}

async function rateLimit(): Promise<void> {
  const now = Date.now()
  const wait = lastRequestAt + NOMINATIM_MIN_INTERVAL_MS - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastRequestAt = Date.now()
}

type NominatimResult = {
  lat: string
  lon: string
  address?: {
    suburb?: string
    neighbourhood?: string
    city_district?: string
    borough?: string
    county?: string
    city?: string
  }
}

/**
 * Geocode a free-text address via Nominatim. Returns null on miss or on any
 * network error (we never throw — geocoding is best-effort).
 */
export async function geocodeAddress(address: string): Promise<GeocodeHit | null> {
  if (!address || !address.trim()) return null
  const key = normalizeAddress(address)
  if (cache.has(key)) return cache.get(key) ?? null

  await rateLimit()

  const url =
    `${NOMINATIM}?q=${encodeURIComponent(`${address}, New York, NY`)}` +
    `&format=json&limit=1&addressdetails=1`

  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
    })
    if (!res.ok) {
      console.warn(`[geocode] nominatim returned ${res.status} for "${address}"`)
      cache.set(key, null)
      return null
    }
    const data = (await res.json()) as NominatimResult[]
    if (!Array.isArray(data) || data.length === 0) {
      cache.set(key, null)
      return null
    }
    const top = data[0]
    const lat = Number.parseFloat(top.lat)
    const lng = Number.parseFloat(top.lon)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      cache.set(key, null)
      return null
    }
    const a = top.address ?? {}
    const neighborhood = a.neighbourhood ?? a.suburb ?? a.city_district ?? null
    const borough = a.borough ?? a.county ?? null
    const hit: GeocodeHit = { lat, lng, neighborhood, borough }
    cache.set(key, hit)
    return hit
  } catch (err) {
    console.warn(`[geocode] error geocoding "${address}": ${(err as Error).message}`)
    cache.set(key, null)
    return null
  }
}

/**
 * NYC neighborhood centroid lookup. ~70 names spanning Manhattan, Brooklyn,
 * Queens, Bronx, Staten Island. Centroids are eyeballed from the NTA polygons
 * and good to ~500m — fine for "nearest station" / "rough commute".
 *
 * Keys are lowercased and hyphen/space-normalized. The LUT below uses the
 * common-spoken form ("West Village") and we normalize the input the same way.
 */
const NEIGHBORHOOD_CENTROIDS: Record<string, { lat: number; lng: number; borough: string }> = {
  // Manhattan
  'west village': { lat: 40.7359, lng: -74.0036, borough: 'Manhattan' },
  'east village': { lat: 40.7264, lng: -73.9818, borough: 'Manhattan' },
  'greenwich village': { lat: 40.7335, lng: -74.0027, borough: 'Manhattan' },
  'lower east side': { lat: 40.7150, lng: -73.9843, borough: 'Manhattan' },
  'soho': { lat: 40.7233, lng: -74.0030, borough: 'Manhattan' },
  'tribeca': { lat: 40.7163, lng: -74.0086, borough: 'Manhattan' },
  'noho': { lat: 40.7280, lng: -73.9931, borough: 'Manhattan' },
  'nolita': { lat: 40.7220, lng: -73.9950, borough: 'Manhattan' },
  'chinatown': { lat: 40.7158, lng: -73.9970, borough: 'Manhattan' },
  'financial district': { lat: 40.7075, lng: -74.0094, borough: 'Manhattan' },
  'fidi': { lat: 40.7075, lng: -74.0094, borough: 'Manhattan' },
  'battery park city': { lat: 40.7115, lng: -74.0163, borough: 'Manhattan' },
  'chelsea': { lat: 40.7465, lng: -74.0014, borough: 'Manhattan' },
  'hells kitchen': { lat: 40.7638, lng: -73.9918, borough: 'Manhattan' },
  "hell's kitchen": { lat: 40.7638, lng: -73.9918, borough: 'Manhattan' },
  'midtown': { lat: 40.7549, lng: -73.9840, borough: 'Manhattan' },
  'midtown east': { lat: 40.7549, lng: -73.9712, borough: 'Manhattan' },
  'midtown west': { lat: 40.7610, lng: -73.9930, borough: 'Manhattan' },
  'murray hill': { lat: 40.7479, lng: -73.9759, borough: 'Manhattan' },
  'kips bay': { lat: 40.7421, lng: -73.9786, borough: 'Manhattan' },
  'gramercy': { lat: 40.7370, lng: -73.9813, borough: 'Manhattan' },
  'flatiron': { lat: 40.7411, lng: -73.9897, borough: 'Manhattan' },
  'union square': { lat: 40.7359, lng: -73.9911, borough: 'Manhattan' },
  'upper east side': { lat: 40.7736, lng: -73.9566, borough: 'Manhattan' },
  'upper west side': { lat: 40.7870, lng: -73.9754, borough: 'Manhattan' },
  'morningside heights': { lat: 40.8090, lng: -73.9626, borough: 'Manhattan' },
  'harlem': { lat: 40.8116, lng: -73.9465, borough: 'Manhattan' },
  'east harlem': { lat: 40.7957, lng: -73.9389, borough: 'Manhattan' },
  'washington heights': { lat: 40.8417, lng: -73.9393, borough: 'Manhattan' },
  'inwood': { lat: 40.8677, lng: -73.9212, borough: 'Manhattan' },
  'roosevelt island': { lat: 40.7615, lng: -73.9501, borough: 'Manhattan' },
  // Brooklyn
  'williamsburg': { lat: 40.7081, lng: -73.9571, borough: 'Brooklyn' },
  'east williamsburg': { lat: 40.7117, lng: -73.9347, borough: 'Brooklyn' },
  'greenpoint': { lat: 40.7295, lng: -73.9536, borough: 'Brooklyn' },
  'bushwick': { lat: 40.6944, lng: -73.9213, borough: 'Brooklyn' },
  'bed-stuy': { lat: 40.6872, lng: -73.9418, borough: 'Brooklyn' },
  'bedford-stuyvesant': { lat: 40.6872, lng: -73.9418, borough: 'Brooklyn' },
  'crown heights': { lat: 40.6694, lng: -73.9442, borough: 'Brooklyn' },
  'prospect heights': { lat: 40.6779, lng: -73.9682, borough: 'Brooklyn' },
  'park slope': { lat: 40.6710, lng: -73.9814, borough: 'Brooklyn' },
  'gowanus': { lat: 40.6735, lng: -73.9897, borough: 'Brooklyn' },
  'carroll gardens': { lat: 40.6797, lng: -73.9986, borough: 'Brooklyn' },
  'cobble hill': { lat: 40.6864, lng: -73.9965, borough: 'Brooklyn' },
  'boerum hill': { lat: 40.6849, lng: -73.9846, borough: 'Brooklyn' },
  'brooklyn heights': { lat: 40.6961, lng: -73.9959, borough: 'Brooklyn' },
  'dumbo': { lat: 40.7033, lng: -73.9881, borough: 'Brooklyn' },
  'fort greene': { lat: 40.6909, lng: -73.9743, borough: 'Brooklyn' },
  'clinton hill': { lat: 40.6884, lng: -73.9665, borough: 'Brooklyn' },
  'flatbush': { lat: 40.6404, lng: -73.9573, borough: 'Brooklyn' },
  'ditmas park': { lat: 40.6356, lng: -73.9602, borough: 'Brooklyn' },
  'sunset park': { lat: 40.6481, lng: -74.0107, borough: 'Brooklyn' },
  'red hook': { lat: 40.6743, lng: -74.0102, borough: 'Brooklyn' },
  'windsor terrace': { lat: 40.6553, lng: -73.9780, borough: 'Brooklyn' },
  'kensington': { lat: 40.6395, lng: -73.9728, borough: 'Brooklyn' },
  'bay ridge': { lat: 40.6258, lng: -74.0290, borough: 'Brooklyn' },
  'sheepshead bay': { lat: 40.5862, lng: -73.9527, borough: 'Brooklyn' },
  'coney island': { lat: 40.5755, lng: -73.9707, borough: 'Brooklyn' },
  'bensonhurst': { lat: 40.6027, lng: -73.9986, borough: 'Brooklyn' },
  // Queens
  'astoria': { lat: 40.7720, lng: -73.9302, borough: 'Queens' },
  'long island city': { lat: 40.7447, lng: -73.9485, borough: 'Queens' },
  'lic': { lat: 40.7447, lng: -73.9485, borough: 'Queens' },
  'sunnyside': { lat: 40.7434, lng: -73.9196, borough: 'Queens' },
  'woodside': { lat: 40.7459, lng: -73.9054, borough: 'Queens' },
  'jackson heights': { lat: 40.7556, lng: -73.8830, borough: 'Queens' },
  'elmhurst': { lat: 40.7370, lng: -73.8770, borough: 'Queens' },
  'corona': { lat: 40.7462, lng: -73.8636, borough: 'Queens' },
  'forest hills': { lat: 40.7187, lng: -73.8448, borough: 'Queens' },
  'rego park': { lat: 40.7280, lng: -73.8615, borough: 'Queens' },
  'flushing': { lat: 40.7654, lng: -73.8318, borough: 'Queens' },
  'ridgewood': { lat: 40.7022, lng: -73.9035, borough: 'Queens' },
  'maspeth': { lat: 40.7222, lng: -73.9090, borough: 'Queens' },
  // Bronx
  'mott haven': { lat: 40.8095, lng: -73.9226, borough: 'Bronx' },
  'south bronx': { lat: 40.8160, lng: -73.9088, borough: 'Bronx' },
  'fordham': { lat: 40.8617, lng: -73.8990, borough: 'Bronx' },
  'riverdale': { lat: 40.8990, lng: -73.9120, borough: 'Bronx' },
  'pelham bay': { lat: 40.8540, lng: -73.8330, borough: 'Bronx' },
  'kingsbridge': { lat: 40.8810, lng: -73.9020, borough: 'Bronx' },
  // Staten Island
  'st. george': { lat: 40.6437, lng: -74.0764, borough: 'Staten Island' },
  'stapleton': { lat: 40.6271, lng: -74.0758, borough: 'Staten Island' },
}

function normalizeNeighborhood(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[_]/g, ' ')
    .replace(/\s+/g, ' ')
}

/**
 * Look up a neighborhood centroid. Returns null on miss — caller decides
 * whether to fall back to "no commute estimate available".
 */
export function geocodeNeighborhood(name: string): { lat: number; lng: number; borough: string } | null {
  const key = normalizeNeighborhood(name)
  return NEIGHBORHOOD_CENTROIDS[key] ?? null
}

/** Test/debug hook: clear the in-memory address cache. */
export function _clearGeocodeCache() {
  cache.clear()
}
