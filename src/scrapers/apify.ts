/**
 * Apify wrapper — generic actor runner + per-site extractors.
 *
 * Why Apify: Zillow / StreetEasy / Trulia / Apartments.com all sit behind
 * Akamai or Cloudflare and reject direct fetch + most headless setups quickly.
 * Apify's community actors maintain rotating residential proxies and parsers.
 *
 * Actor choices (audit notes 2026-05-04):
 *   - Zillow:        `maxcopell~zillow-detail-scraper` — actively maintained
 *                    (last update <30 days), accepts startUrls, outputs full
 *                    detail records (photos, price, agent contact).
 *   - StreetEasy:    `epctex~streeteasy-scraper` — generic search+detail; the
 *                    actor's input takes `search` URLs.
 *   - Trulia:        `epctex~trulia-scraper` — same vendor, similar shape.
 *   - Apartments:    `epctex~apartments-scraper` — same vendor.
 *
 * If the user's chosen actors differ, override IDs by exporting
 * `APIFY_ZILLOW_ACTOR`, `APIFY_STREETEASY_ACTOR`, etc.
 *
 * Each extractor is defensive: actor outputs vary; we tolerate missing fields
 * and fall through to null rather than fabricating.
 */

import type { NewListing } from '@/types'
import { logScrapeError } from './_util'

const APIFY_BASE = 'https://api.apify.com/v2'

function token(): string | null {
  return process.env.APIFY_TOKEN ?? null
}

/**
 * Run a sync actor call and pull the dataset items. Caps at 5 minutes.
 * Returns [] when no token is configured or the actor fails.
 */
export async function runApifyActor<T = unknown>(
  actorId: string,
  input: unknown,
  opts: { timeoutMs?: number; memoryMb?: number } = {}
): Promise<T[]> {
  const t = token()
  if (!t) {
    // eslint-disable-next-line no-console
    console.warn(`[apify] APIFY_TOKEN missing — skipping ${actorId}`)
    return []
  }

  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${t}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5 * 60_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`Apify ${actorId} HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
    const data = (await res.json()) as T[]
    return Array.isArray(data) ? data : []
  } catch (err) {
    logScrapeError(`apify:${actorId}`, url, err)
    return []
  } finally {
    clearTimeout(timer)
  }
}

// ---- helpers shared across extractors ----

function asString(v: unknown): string | null {
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (typeof v === 'number' && Number.isFinite(v)) return v.toString()
  return null
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const m = v.replace(/[$,\s]/g, '').match(/^(\d+(?:\.\d+)?)/)
    if (m) {
      const n = parseFloat(m[1])
      return Number.isFinite(n) ? n : null
    }
  }
  return null
}

function asPhotoArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((it) => {
      if (typeof it === 'string') return it
      if (it && typeof it === 'object') {
        const o = it as Record<string, unknown>
        return (o.url as string) ?? (o.src as string) ?? (o.high_res as string) ?? null
      }
      return null
    })
    .filter((s): s is string => typeof s === 'string' && /^https?:\/\//.test(s))
}

function asDate(v: unknown): Date | null {
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v)
    if (!Number.isNaN(d.getTime())) return d
  }
  return null
}

// ---- Zillow ----

const ZILLOW_ACTOR = process.env.APIFY_ZILLOW_ACTOR ?? 'maxcopell~zillow-detail-scraper'

type ZillowItem = {
  hdpUrl?: string
  url?: string
  detailUrl?: string
  address?: { streetAddress?: string; city?: string; state?: string; zipcode?: string } | string
  streetAddress?: string
  city?: string
  state?: string
  zipcode?: string
  price?: number | string
  rentZestimate?: number
  bedrooms?: number
  bathrooms?: number
  livingArea?: number
  description?: string
  hdpData?: unknown
  photos?: unknown
  images?: unknown
  imgSrc?: string
  brokerName?: string
  agentName?: string
  agentPhoneNumber?: string
  agentEmail?: string
  brokerageName?: string
  daysOnZillow?: number
  datePosted?: string
  latitude?: number
  longitude?: number
  zpid?: number | string
}

function mapZillow(item: ZillowItem): NewListing | null {
  const url =
    item.hdpUrl ??
    item.url ??
    item.detailUrl ??
    (item.zpid ? `https://www.zillow.com/homedetails/${item.zpid}_zpid/` : null)
  if (!url) return null
  const addrObj = typeof item.address === 'object' ? item.address : null
  const address = addrObj?.streetAddress ?? item.streetAddress ?? (typeof item.address === 'string' ? item.address : null) ?? null
  const city = addrObj?.city ?? item.city ?? null
  const state = addrObj?.state ?? item.state ?? null
  const zip = addrObj?.zipcode ?? item.zipcode ?? null
  const photos = asPhotoArray(item.photos) || asPhotoArray(item.images)
  if (photos.length === 0 && item.imgSrc) photos.push(item.imgSrc)

  return {
    source: 'zillow',
    source_url: url,
    title: address ? `${address}${city ? `, ${city}` : ''}` : 'Zillow listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price) ?? item.rentZestimate ?? null,
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.livingArea ?? null,
    photos,
    address,
    borough: city ?? null,
    zip,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agentName ?? item.brokerName,
      agency: item.brokerageName,
      phone: item.agentPhoneNumber,
      email: item.agentEmail,
      preferred_method: item.agentPhoneNumber ? 'phone' : item.agentEmail ? 'email' : undefined,
    },
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: ZILLOW_ACTOR, item: item as unknown },
  }
}

export async function runZillowSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  // The detail-scraper accepts startUrls; we feed it 5 borough rentals search pages.
  const startUrls = [
    'https://www.zillow.com/manhattan-new-york-ny/rentals/',
    'https://www.zillow.com/brooklyn-new-york-ny/rentals/',
    'https://www.zillow.com/queens-new-york-ny/rentals/',
    'https://www.zillow.com/bronx-new-york-ny/rentals/',
    'https://www.zillow.com/staten-island-new-york-ny/rentals/',
  ].map((url) => ({ url }))

  const items = await runApifyActor<ZillowItem>(ZILLOW_ACTOR, {
    startUrls,
    extractionMethod: 'PAGINATION_WITH_ZOOM_IN',
    maxItems: 200,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  })
  return items.map(mapZillow).filter((l): l is NewListing => l != null)
}

// ---- StreetEasy ----

const STREETEASY_ACTOR = process.env.APIFY_STREETEASY_ACTOR ?? 'epctex~streeteasy-scraper'

type StreetEasyItem = {
  url?: string
  detailUrl?: string
  address?: string
  title?: string
  price?: number | string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  description?: string
  photos?: unknown
  images?: unknown
  borough?: string
  neighborhood?: string
  zip?: string
  agentName?: string
  agentPhone?: string
  agentEmail?: string
  brokerage?: string
  noFee?: boolean
  brokerFee?: string
  amenities?: unknown
  availableOn?: string
  datePosted?: string
  latitude?: number
  longitude?: number
}

function mapStreetEasy(item: StreetEasyItem): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  const photos = asPhotoArray(item.photos) || asPhotoArray(item.images)
  const amenities = Array.isArray(item.amenities)
    ? (item.amenities.filter((a) => typeof a === 'string') as string[])
    : []
  return {
    source: 'streeteasy',
    source_url: url,
    title: item.title ?? item.address ?? 'StreetEasy listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price),
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.squareFeet ?? null,
    photos,
    amenities,
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? null,
    borough: item.borough ?? null,
    zip: item.zip ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agentName,
      agency: item.brokerage,
      phone: item.agentPhone,
      email: item.agentEmail,
      preferred_method: item.agentPhone ? 'phone' : item.agentEmail ? 'email' : undefined,
    },
    application: {
      broker_fee_pct: item.noFee ? 0 : undefined,
      broker_fee_text: item.noFee ? 'no fee' : item.brokerFee,
    },
    available_date: asDate(item.availableOn),
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: STREETEASY_ACTOR, item: item as unknown },
  }
}

export async function runStreeteasySearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const startUrls = [
    'https://streeteasy.com/for-rent/manhattan',
    'https://streeteasy.com/for-rent/brooklyn',
    'https://streeteasy.com/for-rent/queens',
  ].map((url) => ({ url }))
  const items = await runApifyActor<StreetEasyItem>(STREETEASY_ACTOR, {
    startUrls,
    maxItems: 200,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  })
  return items.map(mapStreetEasy).filter((l): l is NewListing => l != null)
}

// ---- Trulia ----

const TRULIA_ACTOR = process.env.APIFY_TRULIA_ACTOR ?? 'epctex~trulia-scraper'

type TruliaItem = {
  url?: string
  detailUrl?: string
  address?: string
  price?: number | string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  description?: string
  photos?: unknown
  images?: unknown
  neighborhood?: string
  city?: string
  state?: string
  zip?: string
  agentName?: string
  agentPhone?: string
  brokerage?: string
  datePosted?: string
  latitude?: number
  longitude?: number
}

function mapTrulia(item: TruliaItem): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  return {
    source: 'trulia',
    source_url: url,
    title: item.address ?? 'Trulia listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price),
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.squareFeet ?? null,
    photos: asPhotoArray(item.photos) || asPhotoArray(item.images),
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? null,
    borough: item.city ?? null,
    zip: item.zip ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agentName,
      agency: item.brokerage,
      phone: item.agentPhone,
      preferred_method: item.agentPhone ? 'phone' : undefined,
    },
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: TRULIA_ACTOR, item: item as unknown },
  }
}

export async function runTruliaSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const startUrls = [
    'https://www.trulia.com/for_rent/New_York,NY/',
    'https://www.trulia.com/for_rent/Brooklyn,NY/',
    'https://www.trulia.com/for_rent/Queens,NY/',
  ].map((url) => ({ url }))
  const items = await runApifyActor<TruliaItem>(TRULIA_ACTOR, {
    startUrls,
    maxItems: 200,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  })
  return items.map(mapTrulia).filter((l): l is NewListing => l != null)
}

// ---- Apartments.com ----

const APARTMENTS_ACTOR = process.env.APIFY_APARTMENTS_ACTOR ?? 'epctex~apartments-scraper'

type ApartmentsItem = {
  url?: string
  detailUrl?: string
  propertyName?: string
  title?: string
  address?: string
  price?: number | string
  rent?: { min?: number; max?: number }
  bedrooms?: number | string
  bathrooms?: number | string
  squareFeet?: number
  description?: string
  photos?: unknown
  images?: unknown
  neighborhood?: string
  city?: string
  state?: string
  zip?: string
  phone?: string
  managementCompany?: string
  amenities?: unknown
  datePosted?: string
  latitude?: number
  longitude?: number
}

function mapApartments(item: ApartmentsItem): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  const price =
    asNumber(item.price) ?? (typeof item.rent?.min === 'number' ? item.rent.min : null)
  const beds = item.bedrooms != null ? item.bedrooms.toString() : null
  const baths = item.bathrooms != null ? item.bathrooms.toString() : null
  const amenities = Array.isArray(item.amenities)
    ? (item.amenities.filter((a) => typeof a === 'string') as string[])
    : []
  return {
    source: 'apartments',
    source_url: url,
    title: item.propertyName ?? item.title ?? item.address ?? 'Apartments.com listing',
    description: item.description ?? null,
    price_monthly: price,
    beds,
    baths,
    sqft: item.squareFeet ?? null,
    photos: asPhotoArray(item.photos) || asPhotoArray(item.images),
    amenities,
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? null,
    borough: item.city ?? null,
    zip: item.zip ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.managementCompany,
      phone: item.phone,
      preferred_method: item.phone ? 'phone' : undefined,
    },
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: APARTMENTS_ACTOR, item: item as unknown },
  }
}

export async function runApartmentsSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const startUrls = [
    'https://www.apartments.com/new-york-ny/',
    'https://www.apartments.com/brooklyn-ny/',
    'https://www.apartments.com/queens-ny/',
  ].map((url) => ({ url }))
  const items = await runApifyActor<ApartmentsItem>(APARTMENTS_ACTOR, {
    startUrls,
    maxItems: 200,
    proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  })
  return items.map(mapApartments).filter((l): l is NewListing => l != null)
}
