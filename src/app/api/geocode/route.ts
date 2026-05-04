/**
 * GET /api/geocode?q=<address>
 *
 * Forwards to `geocodeAddress` in `src/lib/geocode.ts` (Nominatim under the
 * hood). Cached via Next 15's `unstable_cache` keyed on the q-value for 24h.
 *
 * Light per-IP rate-limit: 5 req/sec, in-memory map. Fine for personal use,
 * not for public traffic.
 */

import { unstable_cache } from 'next/cache'
import { geocodeAddress, type GeocodeHit } from '@/lib/geocode'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// ---------- rate limiter ----------

const RATE_LIMIT_PER_SEC = 5
const ipBuckets = new Map<string, { windowStart: number; count: number }>()

function clientIp(req: Request): string {
  // Behind Vercel: x-forwarded-for is canonical. Fallback to the remote address.
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim()
  return req.headers.get('x-real-ip') ?? 'unknown'
}

function rateLimited(ip: string): boolean {
  const now = Date.now()
  const bucket = ipBuckets.get(ip)
  if (!bucket || now - bucket.windowStart >= 1000) {
    ipBuckets.set(ip, { windowStart: now, count: 1 })
    return false
  }
  bucket.count++
  return bucket.count > RATE_LIMIT_PER_SEC
}

// ---------- cached geocode ----------

const cachedGeocode = unstable_cache(
  async (q: string): Promise<GeocodeHit | null> => geocodeAddress(q),
  ['homesnatch-geocode-v1'],
  { revalidate: 60 * 60 * 24 } // 24h
)

// ---------- handler ----------

export async function GET(req: Request) {
  const ip = clientIp(req)
  if (rateLimited(ip)) {
    return Response.json(
      { error: 'rate_limited', message: 'Try again in a second.' },
      { status: 429, headers: { 'Retry-After': '1' } }
    )
  }

  const url = new URL(req.url)
  const q = url.searchParams.get('q')?.trim()
  if (!q) {
    return Response.json(
      { error: 'bad_request', message: 'Missing required query param `q`.' },
      { status: 400 }
    )
  }

  try {
    const hit = await cachedGeocode(q)
    if (!hit) {
      return Response.json({ error: 'not_found', q }, { status: 404 })
    }
    return Response.json(hit, { status: 200 })
  } catch (err) {
    console.error('[api/geocode] failed', err)
    return Response.json(
      { error: 'geocode_error', message: (err as Error).message },
      { status: 500 }
    )
  }
}
