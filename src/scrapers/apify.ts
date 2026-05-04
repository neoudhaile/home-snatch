/**
 * Apify wrapper — generic actor runner + per-site extractors with profile-aware
 * search-variant fan-out.
 *
 * Why Apify: Zillow / StreetEasy / Trulia / Apartments / Realtor / Redfin /
 * HotPads all sit behind Akamai or Cloudflare and reject direct fetch + most
 * headless setups quickly. Apify's community actors maintain rotating residential
 * proxies and parsers we'd otherwise have to maintain ourselves.
 *
 * Budget mode (`APIFY_BUDGET_MODE` env, default = `standard` if APIFY_TOKEN is
 * set, else `light`):
 *
 *   - `light`       — 1 search per actor          (≈0.05 actor-hr / pass)
 *   - `standard`    — 4 borough searches per actor (≈0.5 actor-hr / pass)
 *   - `aggressive`  — up to 12 searches per actor: 4 boroughs + ≤3 bed-counts
 *                     + ≤5 preferred neighborhoods   (≈1.5 actor-hr / pass)
 *
 * Search variants are generated per-actor from `loadAllProfileFiles()`:
 *   1. Borough sweep — Manhattan / Brooklyn / Queens / Bronx
 *   2. Bed-count sweep — beds_min .. beds_max from joint constraints
 *   3. Neighborhood sweep — top N from union of `preferred_areas` across profiles
 *
 * Each actor exports its own `runXxxSearchNYC()` function so the orchestrator
 * doesn't have to know anything about variants. The actor-level extractor is
 * defensive — actor outputs vary across forks; we tolerate missing fields and
 * fall through to null rather than fabricating.
 *
 * Actor choices (audit notes 2026-05-04 — switched to FREE-tier actors):
 *
 *   - Zillow      — `parseforge/zillow-rentals-scraper`
 *                   Input:  { listingUrl, maxItems, proxyConfig }
 *                   Schema: https://apify.com/parseforge/zillow-rentals-scraper/input-schema
 *   - StreetEasy  — `shahidirfan/StreetEasy-Scraper`
 *                   Input:  { start_url, listing_type, results_wanted, max_pages, proxyConfiguration }
 *                   Schema: https://apify.com/shahidirfan/StreetEasy-Scraper/input-schema
 *   - Apartments  — `sovereigntaylor/apartments-scraper`
 *                   Input:  { locations[], minRent, maxRent, beds, baths, petFriendly, maxResults, proxyConfiguration }
 *                   Schema: https://apify.com/sovereigntaylor/apartments-scraper/input-schema
 *   - Realtor     — `sovereigntaylor/realtor-scraper`
 *                   Input:  { locations[], propertyType, minPrice, maxPrice, minBeds, minBaths, status, maxResults, proxyConfiguration }
 *                   Schema: https://apify.com/sovereigntaylor/realtor-scraper/input-schema
 *   - Trulia      — `epctex~trulia-scraper` (paid; passthrough — no FREE actor)
 *   - Redfin      — `epctex~redfin-scraper` (paid; passthrough — no FREE actor)
 *   - HotPads     — `epctex~hotpads-scraper` (paid; passthrough — no FREE actor)
 *   - RentHop     — `epctex~renthop-scraper` (paid; passthrough — no FREE actor)
 *   - Twitter/X   — `apidojo~twitter-scraper-lite` (free-tier-friendly).
 *                   Filters to a curated list of NYC listing accounts.
 *
 * The four FREE actors above have DIFFERENT input shapes from each other
 * (NOT the unified `startUrls` pattern of the epctex suite) — each actor's
 * mapper writes the exact input shape its README documents. To override the
 * actor used (e.g. swap to a paid alternative), set APIFY_<SOURCE>_ACTOR; if
 * you do, you'll likely also need to adjust the input shape in this file.
 */

import type { NewListing } from '@/types'
import { loadAllProfileFiles, type ProfileFile } from '@/lib/profile-set'
import { logScrapeError } from './_util'

const APIFY_BASE = 'https://api.apify.com/v2'

function token(): string | null {
  return process.env.APIFY_TOKEN ?? null
}

// ---- Budget mode ----

export type BudgetMode = 'light' | 'standard' | 'aggressive'

function budgetMode(): BudgetMode {
  const raw = (process.env.APIFY_BUDGET_MODE ?? '').toLowerCase()
  if (raw === 'light' || raw === 'standard' || raw === 'aggressive') return raw
  return token() ? 'standard' : 'light'
}

/**
 * Hard cap on how many searches we'll run per actor in a single sweep. Apify
 * dedupes its own dataset across runs and we dedupe by `source_url` after, so
 * overlap is fine — this just bounds the cost ceiling.
 */
const MAX_SEARCHES_PER_ACTOR = 12

// ---- Variant generation ----

type Variant = {
  /** Human-readable label, ends up in `raw.variant` for traceability. */
  label: string
  /** Borough name (proper-cased) when this is a borough sweep. */
  borough?: 'Manhattan' | 'Brooklyn' | 'Queens' | 'Bronx' | 'Staten Island'
  /** Bedroom count this variant filters to (null = any). */
  beds?: number
  /** Free-form neighborhood string (uses joint preferred_areas). */
  neighborhood?: string
  /** Joint budget cap from profile set, or null if neither side set one. */
  budgetMax?: number | null
}

/**
 * Sane default boroughs we always sweep when running ≥standard mode.
 */
const DEFAULT_BOROUGHS: Array<NonNullable<Variant['borough']>> = [
  'Manhattan',
  'Brooklyn',
  'Queens',
  'Bronx',
]

/** Strip a free-form neighborhood string into something URL-safe. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Build the variant set for the current sweep. Uses profile JSON if available,
 * else falls back to a 4-borough sweep with no bed/neighborhood filters.
 */
async function buildVariants(): Promise<Variant[]> {
  const mode = budgetMode()
  if (mode === 'light') {
    return [{ label: 'nyc-all' }]
  }

  let profiles: ProfileFile[] = []
  try {
    profiles = await loadAllProfileFiles()
  } catch {
    profiles = []
  }

  // Joint budget cap: tightest budget_max across profiles (cap, not floor).
  const budgets = profiles.map((p) => p.budget_max).filter((v): v is number => v != null)
  const budgetMax = budgets.length ? Math.min(...budgets) : null

  // Borough sweep — the always-on baseline for ≥standard.
  const variants: Variant[] = DEFAULT_BOROUGHS.map((b) => ({
    label: `borough:${b.toLowerCase().replace(/\s+/g, '-')}`,
    borough: b,
    budgetMax,
  }))

  if (mode === 'standard') return variants.slice(0, MAX_SEARCHES_PER_ACTOR)

  // Aggressive: add bed-counts (intersection of profile beds_min..beds_max)
  const bedsMins = profiles.map((p) => p.beds_min).filter((v): v is number => v != null)
  const bedsMaxes = profiles.map((p) => p.beds_max).filter((v): v is number => v != null)
  const bedsMin = bedsMins.length ? Math.max(...bedsMins) : null
  const bedsMax = bedsMaxes.length ? Math.min(...bedsMaxes) : null
  if (bedsMin != null && bedsMax != null && bedsMax >= bedsMin) {
    for (let b = bedsMin; b <= bedsMax && b <= 4; b++) {
      variants.push({
        label: `beds:${b}`,
        beds: b,
        budgetMax,
      })
    }
  }

  // Aggressive: add top-N preferred_areas across profiles (skip FILL_ME).
  const areas = Array.from(
    new Set(
      profiles
        .flatMap((p) => p.preferred_areas ?? [])
        .map((a) => (typeof a === 'string' ? a.trim() : ''))
        .filter((a) => a.length > 0 && !a.includes('FILL_ME')),
    ),
  ).slice(0, 5)
  for (const n of areas) {
    variants.push({
      label: `nbhd:${slugify(n)}`,
      neighborhood: n,
      budgetMax,
    })
  }

  return variants.slice(0, MAX_SEARCHES_PER_ACTOR)
}

// ---- Generic actor runner ----

/**
 * Run a sync actor call and pull the dataset items. Caps at 5 minutes.
 * Returns [] when no token is configured or the actor fails.
 */
export async function runApifyActor<T = unknown>(
  actorId: string,
  input: unknown,
  opts: { timeoutMs?: number; memoryMb?: number } = {},
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

/**
 * Dedupe a list of NewListings by source_url, keeping the first occurrence.
 * Used to merge the output of N variant runs into one stream.
 */
function dedupeByUrl(items: NewListing[]): NewListing[] {
  const seen = new Set<string>()
  const out: NewListing[] = []
  for (const it of items) {
    if (!it.source_url || seen.has(it.source_url)) continue
    seen.add(it.source_url)
    out.push(it)
  }
  return out
}

/**
 * Run the same actor across N variants (parallel, capped) and return the
 * merged-deduped results. Each variant produces its own `startUrls` via the
 * caller-supplied `urlFor` mapper.
 */
async function runVariantSweep<T>(opts: {
  actorId: string
  variants: Variant[]
  urlFor: (v: Variant) => string | null
  extraInput?: (v: Variant) => Record<string, unknown>
  mapItem: (item: T, v: Variant) => NewListing | null
}): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const results: NewListing[] = []
  // 2-at-a-time so we don't hammer Apify with parallel sync runs.
  let i = 0
  while (i < opts.variants.length) {
    const slice = opts.variants.slice(i, i + 2)
    i += 2
    const got = await Promise.all(
      slice.map(async (v) => {
        const url = opts.urlFor(v)
        if (!url) return [] as NewListing[]
        const startUrls = [{ url }]
        const input = {
          startUrls,
          maxItems: 200,
          proxyConfiguration: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
          ...(opts.extraInput?.(v) ?? {}),
        }
        const items = await runApifyActor<T>(opts.actorId, input)
        return items
          .map((it) => opts.mapItem(it, v))
          .filter((l): l is NewListing => l != null)
      }),
    )
    for (const arr of got) results.push(...arr)
  }
  return dedupeByUrl(results)
}

// =================================================================================
// Zillow — parseforge/zillow-rentals-scraper (FREE actor)
// =================================================================================
// Input schema (per https://apify.com/parseforge/zillow-rentals-scraper/input-schema):
//   { listingUrl: string (REQUIRED), maxItems: int, proxyConfig: object }
//   NOTE: ONE listingUrl per run — not the `startUrls[]` shape of epctex actors.
// Output (38 fields documented):
//   { url, zpid, address, city, state, zipCode, latitude, longitude,
//     bedrooms, bathrooms, livingArea, propertyType, price, currency,
//     homeStatus, daysOnZillow, rentZestimate, imageUrl, imageUrls[],
//     brokerName, depositMin, depositMax, leaseTerms, availableFrom,
//     buildingName, unitNumber, scrapedAt, description, parking, heating,
//     cooling, appliances, petPolicy, laundry, ... }

const ZILLOW_ACTOR = process.env.APIFY_ZILLOW_ACTOR ?? 'parseforge~zillow-rentals-scraper'

type ZillowItem = {
  url?: string
  zpid?: number | string
  address?: string
  city?: string
  state?: string
  zipCode?: string
  latitude?: number
  longitude?: number
  bedrooms?: number
  bathrooms?: number
  livingArea?: number
  propertyType?: string
  price?: number | string
  currency?: string
  homeStatus?: string
  daysOnZillow?: number
  rentZestimate?: number
  imageUrl?: string
  imageUrls?: unknown
  brokerName?: string
  depositMin?: number
  depositMax?: number
  leaseTerms?: string
  availableFrom?: string
  buildingName?: string
  unitNumber?: string
  scrapedAt?: string
  description?: string
  petPolicy?: string
  laundry?: string
}

function zillowSearchUrl(v: Variant): string {
  // Format: https://www.zillow.com/<area>-new-york-ny/rentals/<beds>-_beds/
  const base = 'https://www.zillow.com'
  let area = 'new-york-ny'
  if (v.borough) area = `${slugify(v.borough)}-new-york-ny`
  if (v.neighborhood) area = `${slugify(v.neighborhood)}-new-york-ny`
  let path = `/${area}/rentals/`
  if (v.beds != null) path += `${v.beds}-_beds/`
  return `${base}${path}`
}

function mapZillow(item: ZillowItem, v: Variant): NewListing | null {
  const url =
    item.url ??
    (item.zpid ? `https://www.zillow.com/homedetails/${item.zpid}_zpid/` : null)
  if (!url) return null
  const photos = asPhotoArray(item.imageUrls)
  if (photos.length === 0 && item.imageUrl) photos.push(item.imageUrl)
  const petFriendly =
    typeof item.petPolicy === 'string'
      ? /(allowed|cats|dogs|yes|ok|friendly)/i.test(item.petPolicy) &&
        !/no\s+(pets|cats|dogs)/i.test(item.petPolicy)
      : null
  const unitTitle = [item.buildingName, item.unitNumber].filter(Boolean).join(' #')

  return {
    source: 'zillow',
    source_url: url,
    title: unitTitle || item.address || 'Zillow listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price) ?? item.rentZestimate ?? null,
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.livingArea ?? null,
    available_date: asDate(item.availableFrom),
    lease_term: item.leaseTerms ?? null,
    pet_friendly: petFriendly,
    photos,
    address: item.address ?? null,
    unit: item.unitNumber ?? null,
    borough: v.borough ?? item.city ?? null,
    neighborhood: v.neighborhood ?? null,
    zip: item.zipCode ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.brokerName,
      preferred_method: undefined,
    },
    posted_at:
      typeof item.daysOnZillow === 'number'
        ? new Date(Date.now() - item.daysOnZillow * 24 * 60 * 60 * 1000)
        : asDate(item.scrapedAt),
    is_active: true,
    raw: { actor: ZILLOW_ACTOR, variant: v.label, item: item as unknown },
  }
}

/**
 * Zillow's FREE actor takes ONE listingUrl per run, not startUrls[]. We can't
 * use `runVariantSweep` (which assumes the epctex/startUrls shape), so we
 * run each variant manually with the actor-specific input shape.
 */
export async function runZillowSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const variants = await buildVariants()
  const results: NewListing[] = []
  let i = 0
  while (i < variants.length) {
    const slice = variants.slice(i, i + 2)
    i += 2
    const got = await Promise.all(
      slice.map(async (v) => {
        const url = zillowSearchUrl(v)
        const items = await runApifyActor<ZillowItem>(ZILLOW_ACTOR, {
          listingUrl: url,
          maxItems: 100,
          proxyConfig: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
        })
        return items
          .map((it) => mapZillow(it, v))
          .filter((l): l is NewListing => l != null)
      }),
    )
    for (const arr of got) results.push(...arr)
  }
  return dedupeByUrl(results)
}

// =================================================================================
// StreetEasy — shahidirfan/StreetEasy-Scraper (FREE actor)
// =================================================================================
// Input schema (per https://apify.com/shahidirfan/StreetEasy-Scraper/input-schema):
//   { start_url: string, listing_type: 'for-sale'|'for-rent', results_wanted: int,
//     max_pages: int, proxyConfiguration: object }
//   NOTE: snake_case keys. We always set listing_type='for-rent'.
// Output (NYC-only fields, all string-typed):
//   { url, price, address, neighborhood, beds, baths, sqft, property_type,
//     broker, image_url }
//   Caveat: this actor's output is thin (no agent contact/email/phone, no
//   posted_at, no description). We map what's there; consumers downstream can
//   re-fetch the URL via direct/Browserless to enrich if needed.

const STREETEASY_ACTOR =
  process.env.APIFY_STREETEASY_ACTOR ?? 'shahidirfan~StreetEasy-Scraper'

type StreetEasyItem = {
  url?: string
  price?: string | number
  address?: string
  neighborhood?: string
  beds?: string | number
  baths?: string | number
  sqft?: string | number
  property_type?: string
  broker?: string
  image_url?: string
}

function streetEasySearchUrl(v: Variant): string {
  // StreetEasy: https://streeteasy.com/for-rent/<area>?price=-<max>&beds=<n>
  const base = 'https://streeteasy.com/for-rent'
  let area = 'nyc'
  if (v.borough) area = slugify(v.borough)
  if (v.neighborhood) area = slugify(v.neighborhood)
  const params = new URLSearchParams()
  if (v.budgetMax) params.set('price', `-${v.budgetMax}`)
  if (v.beds != null) params.set('beds', String(v.beds))
  const qs = params.toString()
  return `${base}/${area}${qs ? `?${qs}` : ''}`
}

function mapStreetEasy(item: StreetEasyItem, v: Variant): NewListing | null {
  if (!item.url) return null
  const photos: string[] = []
  if (item.image_url && /^https?:\/\//.test(item.image_url)) photos.push(item.image_url)
  return {
    source: 'streeteasy',
    source_url: item.url,
    title: item.address ?? item.property_type ?? 'StreetEasy listing',
    description: null,
    price_monthly: asNumber(item.price),
    beds:
      typeof item.beds === 'number'
        ? item.beds.toString()
        : asNumber(item.beds)?.toString() ?? null,
    baths:
      typeof item.baths === 'number'
        ? item.baths.toString()
        : asNumber(item.baths)?.toString() ?? null,
    sqft: typeof item.sqft === 'number' ? item.sqft : asNumber(item.sqft),
    photos,
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? v.neighborhood ?? null,
    borough: v.borough ?? null,
    contact: {
      agency: item.broker,
      preferred_method: undefined,
    },
    is_active: true,
    raw: { actor: STREETEASY_ACTOR, variant: v.label, item: item as unknown },
  }
}

/**
 * StreetEasy actor takes ONE start_url per run. We fan out per variant.
 */
export async function runStreeteasySearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const variants = await buildVariants()
  const results: NewListing[] = []
  let i = 0
  while (i < variants.length) {
    const slice = variants.slice(i, i + 2)
    i += 2
    const got = await Promise.all(
      slice.map(async (v) => {
        const url = streetEasySearchUrl(v)
        const items = await runApifyActor<StreetEasyItem>(STREETEASY_ACTOR, {
          start_url: url,
          listing_type: 'for-rent',
          results_wanted: 50,
          max_pages: 5,
          proxyConfiguration: {
            useApifyProxy: true,
            apifyProxyGroups: ['RESIDENTIAL'],
          },
        })
        return items
          .map((it) => mapStreetEasy(it, v))
          .filter((l): l is NewListing => l != null)
      }),
    )
    for (const arr of got) results.push(...arr)
  }
  return dedupeByUrl(results)
}

// =================================================================================
// Trulia
// =================================================================================

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

function truliaSearchUrl(v: Variant): string {
  // Trulia: https://www.trulia.com/for_rent/<City>,NY/  ; bed filter via ?beds=
  const base = 'https://www.trulia.com/for_rent'
  let area = 'New_York,NY'
  if (v.borough) area = `${v.borough.replace(/\s+/g, '_')},NY`
  // Trulia doesn't have great neighborhood URL slugs; we fold neighborhood into a
  // generic NYC search and let the actor re-filter.
  const params = new URLSearchParams()
  if (v.beds != null) params.set('beds', String(v.beds))
  if (v.budgetMax) params.set('price', `0-${v.budgetMax}`)
  const qs = params.toString()
  return `${base}/${area}/${qs ? `?${qs}` : ''}`
}

function mapTrulia(item: TruliaItem, v: Variant): NewListing | null {
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
    neighborhood: item.neighborhood ?? v.neighborhood ?? null,
    borough: item.city ?? v.borough ?? null,
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
    raw: { actor: TRULIA_ACTOR, variant: v.label, item: item as unknown },
  }
}

export async function runTruliaSearchNYC(): Promise<NewListing[]> {
  const variants = await buildVariants()
  return runVariantSweep<TruliaItem>({
    actorId: TRULIA_ACTOR,
    variants,
    urlFor: truliaSearchUrl,
    mapItem: mapTrulia,
  })
}

// =================================================================================
// Apartments.com — sovereigntaylor/apartments-scraper (FREE actor)
// =================================================================================
// Input schema (per https://apify.com/sovereigntaylor/apartments-scraper/input-schema):
//   { locations: string[] (REQUIRED — city names, neighborhoods, or full URLs),
//     minRent: int, maxRent: int, beds: int (min beds), baths: int (min baths),
//     petFriendly: bool, maxResults: int, proxyConfiguration: object }
//   NOTE: locations is an array — we batch all variants into a single run when
//   possible, since the actor handles multiple locations per call.
// Output:
//   { url, listingId, name, address, city, state, zipCode, neighborhood,
//     rent (string), rentMin, rentMax, fees[], beds, baths, sqft, floorPlans[],
//     amenities[], description, propertyType, yearBuilt, images[], parking,
//     petPolicy, petFriendly, contact{phone, officeHours, managementCompany},
//     latitude, longitude, walkScore, transitScore, rating, reviewCount,
//     scrapedAt, ... }

const APARTMENTS_ACTOR =
  process.env.APIFY_APARTMENTS_ACTOR ?? 'sovereigntaylor~apartments-scraper'

type ApartmentsItem = {
  url?: string
  listingId?: string
  name?: string
  address?: string
  city?: string
  state?: string
  zipCode?: string
  neighborhood?: string
  rent?: string
  rentMin?: number
  rentMax?: number
  fees?: Array<{ type?: string; amount?: number; description?: string }>
  beds?: number | string
  baths?: number | string
  sqft?: number | string
  floorPlans?: unknown
  amenities?: unknown
  description?: string
  propertyType?: string
  images?: unknown
  parking?: string
  petPolicy?: string
  petFriendly?: boolean
  contact?: { phone?: string; officeHours?: string; managementCompany?: string }
  latitude?: number
  longitude?: number
  walkScore?: number
  transitScore?: number
  scrapedAt?: string
}

function apartmentsLocation(v: Variant): string {
  // Apartments.com accepts URL slugs as 'locations' entries.
  // E.g. "new-york-ny", "brooklyn-ny", "williamsburg-new-york-ny"
  if (v.neighborhood) return `${slugify(v.neighborhood)}-new-york-ny`
  if (v.borough) return `${slugify(v.borough)}-ny`
  return 'new-york-ny'
}

function mapApartments(item: ApartmentsItem, v: Variant): NewListing | null {
  if (!item.url) return null
  // Pull application fee from `fees[]` if present.
  const appFee = Array.isArray(item.fees)
    ? (() => {
        const f = item.fees!.find(
          (x) => typeof x?.type === 'string' && /application/i.test(x.type),
        )
        return typeof f?.amount === 'number' ? f.amount : undefined
      })()
    : undefined

  const price =
    typeof item.rentMin === 'number'
      ? item.rentMin
      : typeof item.rentMax === 'number'
        ? item.rentMax
        : asNumber(item.rent)

  const amenities = Array.isArray(item.amenities)
    ? (item.amenities.filter((a) => typeof a === 'string') as string[])
    : []

  return {
    source: 'apartments',
    source_url: item.url,
    title: item.name ?? item.address ?? 'Apartments.com listing',
    description: item.description ?? null,
    price_monthly: price,
    beds:
      typeof item.beds === 'number'
        ? item.beds.toString()
        : asNumber(item.beds)?.toString() ?? null,
    baths:
      typeof item.baths === 'number'
        ? item.baths.toString()
        : asNumber(item.baths)?.toString() ?? null,
    sqft: typeof item.sqft === 'number' ? item.sqft : asNumber(item.sqft),
    pet_friendly:
      typeof item.petFriendly === 'boolean'
        ? item.petFriendly
        : item.petPolicy
          ? /(allowed|yes|ok|cats|dogs)/i.test(item.petPolicy) &&
            !/no\s+(pets|cats|dogs)/i.test(item.petPolicy)
          : null,
    amenities,
    photos: asPhotoArray(item.images),
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? v.neighborhood ?? null,
    borough: v.borough ?? item.city ?? null,
    zip: item.zipCode ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.contact?.managementCompany,
      phone: item.contact?.phone,
      preferred_method: item.contact?.phone ? 'phone' : undefined,
    },
    application: {
      fee: appFee,
    },
    posted_at: asDate(item.scrapedAt),
    is_active: true,
    raw: { actor: APARTMENTS_ACTOR, variant: v.label, item: item as unknown },
  }
}

/**
 * Apartments.com FREE actor accepts an array of locations in ONE run. We batch
 * all variants into a single run for efficiency (one Apify charge per
 * sweep, not N).
 */
export async function runApartmentsSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const variants = await buildVariants()
  if (variants.length === 0) return []

  // Pull joint budget cap from the first variant that has one (all variants
  // in a sweep share the same budgetMax; see buildVariants).
  const budgetMax = variants.find((v) => v.budgetMax != null)?.budgetMax ?? null
  // For beds, only filter at actor-level if ALL variants agree on a single
  // beds count. Otherwise leave it at 0 (any) and post-filter in JS via the
  // normal feed pipeline.
  const bedsSet = new Set(variants.map((v) => v.beds).filter((b) => b != null) as number[])
  const beds = bedsSet.size === 1 ? [...bedsSet][0] : 0

  const locations = Array.from(new Set(variants.map(apartmentsLocation)))
  const items = await runApifyActor<ApartmentsItem>(APARTMENTS_ACTOR, {
    locations,
    minRent: 0,
    maxRent: budgetMax ?? 0,
    beds,
    baths: 0,
    petFriendly: false,
    maxResults: Math.min(200, locations.length * 50),
    proxyConfiguration: { useApifyProxy: true },
  })

  // The actor returns items without telling us which location-variant each
  // belongs to, so we annotate with a synthesized "all" variant.
  const allVariant: Variant = { label: `apartments:batch(${locations.length})` }
  return dedupeByUrl(
    items.map((it) => mapApartments(it, allVariant)).filter((l): l is NewListing => l != null),
  )
}

// =================================================================================
// Realtor.com — sovereigntaylor/realtor-scraper (FREE actor)
// =================================================================================
// Input schema (per https://apify.com/sovereigntaylor/realtor-scraper/input-schema):
//   { locations: string[] (REQUIRED — "City-Name_ST" format like "New-York_NY"
//     or ZIP codes), propertyType: 'any'|'single_family'|'multi_family'|
//     'condo'|'townhouse'|'mobile'|'land'|'farm', minPrice: int, maxPrice: int,
//     minBeds: int, minBaths: int, status: 'for_sale'|'for_rent'|'recently_sold'|
//     'pending', maxResults: int (per location), proxyConfiguration: object }
//   NOTE: status='for_rent' is essential for our use case.
// Output:
//   { url, propertyId, address, streetAddress, city, state, zipcode, price,
//     priceFormatted, beds, baths, bathsFull, bathsHalf, sqft, lotSize,
//     yearBuilt, propertyType, status, daysOnMarket, listDate, agent,
//     agentPhone, brokerage, mlsId, primaryImage, images[], latitude,
//     longitude, scrapedAt, ... and detail-page extras: description,
//     neighborhood{walkScore,transitScore,bikeScore}, schools, features }

const REALTOR_ACTOR = process.env.APIFY_REALTOR_ACTOR ?? 'sovereigntaylor~realtor-scraper'

type RealtorItem = {
  url?: string
  propertyId?: string
  address?: string
  streetAddress?: string
  city?: string
  state?: string
  zipcode?: string
  price?: number | string
  priceFormatted?: string
  beds?: number
  baths?: number
  bathsFull?: number
  bathsHalf?: number
  sqft?: number
  yearBuilt?: number
  propertyType?: string
  status?: string
  daysOnMarket?: number
  listDate?: string
  agent?: string
  agentPhone?: string
  brokerage?: string
  mlsId?: string
  primaryImage?: string
  images?: unknown
  latitude?: number
  longitude?: number
  scrapedAt?: string
  description?: string
  neighborhood?:
    | string
    | { name?: string; walkScore?: number; transitScore?: number; bikeScore?: number }
}

function realtorLocation(v: Variant): string {
  // Realtor wants "City-Name_ST" with hyphens.
  if (v.borough) return `${v.borough.replace(/\s+/g, '-')}_NY`
  return 'New-York_NY'
}

function mapRealtor(item: RealtorItem, v: Variant): NewListing | null {
  if (!item.url) return null
  const photos = asPhotoArray(item.images)
  if (photos.length === 0 && item.primaryImage) photos.push(item.primaryImage)
  const nbhd =
    typeof item.neighborhood === 'string'
      ? item.neighborhood
      : item.neighborhood?.name ?? null
  const address = item.streetAddress ?? item.address ?? null

  return {
    source: 'realtor',
    source_url: item.url,
    title: address ?? 'Realtor.com listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price) ?? asNumber(item.priceFormatted),
    beds: item.beds != null ? item.beds.toString() : null,
    baths: item.baths != null ? item.baths.toString() : null,
    sqft: item.sqft ?? null,
    photos,
    address,
    neighborhood: nbhd ?? v.neighborhood ?? null,
    borough: v.borough ?? item.city ?? null,
    zip: item.zipcode ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agent,
      agency: item.brokerage,
      phone: item.agentPhone,
      preferred_method: item.agentPhone ? 'phone' : undefined,
    },
    posted_at:
      asDate(item.listDate) ??
      (typeof item.daysOnMarket === 'number'
        ? new Date(Date.now() - item.daysOnMarket * 24 * 60 * 60 * 1000)
        : asDate(item.scrapedAt)),
    is_active: true,
    raw: { actor: REALTOR_ACTOR, variant: v.label, item: item as unknown },
  }
}

/**
 * Realtor.com FREE actor accepts an array of locations in ONE run. Same
 * batching strategy as Apartments.com.
 */
export async function runRealtorSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  const variants = await buildVariants()
  if (variants.length === 0) return []

  const budgetMax = variants.find((v) => v.budgetMax != null)?.budgetMax ?? null
  const bedsSet = new Set(variants.map((v) => v.beds).filter((b) => b != null) as number[])
  const minBeds = bedsSet.size === 1 ? [...bedsSet][0] : 0

  const locations = Array.from(new Set(variants.map(realtorLocation)))
  const items = await runApifyActor<RealtorItem>(REALTOR_ACTOR, {
    locations,
    propertyType: 'any',
    minPrice: 0,
    maxPrice: budgetMax ?? 0,
    minBeds,
    minBaths: 0,
    status: 'for_rent',
    maxResults: Math.min(500, locations.length * 100),
    proxyConfiguration: { useApifyProxy: true },
  })

  const allVariant: Variant = { label: `realtor:batch(${locations.length})` }
  return dedupeByUrl(
    items.map((it) => mapRealtor(it, allVariant)).filter((l): l is NewListing => l != null),
  )
}

// =================================================================================
// Redfin
// =================================================================================
// Why this actor: redfin.com publishes a fair number of NYC rentals that aren't
// indexed by Zillow (since Redfin operates as the lister, not aggregator on these).
// `epctex~redfin-scraper` is the same vendor pattern; alt:
// `compass~redfin-scraper` (override via APIFY_REDFIN_ACTOR).
// Expected output volume: 30-150/sweep.

const REDFIN_ACTOR = process.env.APIFY_REDFIN_ACTOR ?? 'epctex~redfin-scraper'

type RedfinItem = {
  url?: string
  detailUrl?: string
  mlsId?: string | number
  streetAddress?: string
  address?: string
  city?: string
  state?: string
  zip?: string | number
  price?: number | string
  beds?: number
  baths?: number
  sqft?: number
  description?: string
  photos?: unknown
  images?: unknown
  agentName?: string
  agentPhone?: string
  brokerage?: string
  listDate?: string
  latitude?: number
  longitude?: number
}

function redfinSearchUrl(v: Variant): string {
  // Redfin rental search: https://www.redfin.com/city/30749/NY/New-York/apartments-for-rent
  // Per-borough redfin city IDs are stable; for simplicity we point at the NYC
  // umbrella and let the actor crawl. Borough is annotated in the variant label.
  const base = 'https://www.redfin.com/city/30749/NY/New-York/apartments-for-rent'
  const params = new URLSearchParams()
  if (v.beds != null) params.set('min-beds', String(v.beds))
  if (v.budgetMax) params.set('max-price', String(v.budgetMax))
  const qs = params.toString()
  return qs ? `${base}?${qs}` : base
}

function mapRedfin(item: RedfinItem, v: Variant): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  const photos = asPhotoArray(item.photos) || asPhotoArray(item.images)
  const address = item.streetAddress ?? item.address ?? null
  return {
    source: 'redfin',
    source_url: url,
    title: address ?? 'Redfin listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price),
    beds: item.beds != null ? item.beds.toString() : null,
    baths: item.baths != null ? item.baths.toString() : null,
    sqft: item.sqft ?? null,
    photos,
    address,
    neighborhood: v.neighborhood ?? null,
    borough: v.borough ?? item.city ?? null,
    zip: item.zip != null ? String(item.zip) : null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agentName,
      agency: item.brokerage,
      phone: item.agentPhone,
      preferred_method: item.agentPhone ? 'phone' : undefined,
    },
    posted_at: asDate(item.listDate),
    is_active: true,
    raw: { actor: REDFIN_ACTOR, variant: v.label, item: item as unknown },
  }
}

export async function runRedfinSearchNYC(): Promise<NewListing[]> {
  const variants = await buildVariants()
  return runVariantSweep<RedfinItem>({
    actorId: REDFIN_ACTOR,
    variants,
    urlFor: redfinSearchUrl,
    mapItem: mapRedfin,
  })
}

// =================================================================================
// HotPads
// =================================================================================
// Why this actor: HotPads (Zillow Group sister site, but a separate inventory in
// places — a fair number of small-landlord NYC listings appear here that don't
// hit Zillow). `epctex~hotpads-scraper` is the consistent vendor pick. If the
// actor is missing or paid-only at run-time, fall back to direct via
// `src/scrapers/hotpads.ts`.
// Expected output volume: 50-200/sweep.

const HOTPADS_ACTOR = process.env.APIFY_HOTPADS_ACTOR ?? 'epctex~hotpads-scraper'

type HotPadsItem = {
  url?: string
  detailUrl?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  price?: number | string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  description?: string
  photos?: unknown
  images?: unknown
  neighborhood?: string
  agentName?: string
  agentPhone?: string
  agentEmail?: string
  amenities?: unknown
  datePosted?: string
  availableOn?: string
  latitude?: number
  longitude?: number
}

function hotPadsSearchUrl(v: Variant): string {
  // HotPads: https://hotpads.com/<area>/apartments-for-rent?...
  const base = 'https://hotpads.com'
  let area = 'new-york-ny'
  if (v.borough) area = `${slugify(v.borough)}-ny`
  if (v.neighborhood) area = `${slugify(v.neighborhood)}-new-york-ny`
  const params = new URLSearchParams()
  if (v.beds != null) params.set('beds', String(v.beds))
  if (v.budgetMax) params.set('maxPrice', String(v.budgetMax))
  const qs = params.toString()
  return `${base}/${area}/apartments-for-rent${qs ? `?${qs}` : ''}`
}

function mapHotPads(item: HotPadsItem, v: Variant): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  const photos = asPhotoArray(item.photos) || asPhotoArray(item.images)
  const amenities = Array.isArray(item.amenities)
    ? (item.amenities.filter((a) => typeof a === 'string') as string[])
    : []
  return {
    source: 'hotpads',
    source_url: url,
    title: item.address ?? 'HotPads listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price),
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.squareFeet ?? null,
    photos,
    amenities,
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? v.neighborhood ?? null,
    borough: v.borough ?? item.city ?? null,
    zip: item.zip ?? null,
    lat: item.latitude ?? null,
    lng: item.longitude ?? null,
    contact: {
      name: item.agentName,
      phone: item.agentPhone,
      email: item.agentEmail,
      preferred_method: item.agentPhone ? 'phone' : item.agentEmail ? 'email' : undefined,
    },
    available_date: asDate(item.availableOn),
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: HOTPADS_ACTOR, variant: v.label, item: item as unknown },
  }
}

export async function runHotPadsSearchNYC(): Promise<NewListing[]> {
  const variants = await buildVariants()
  return runVariantSweep<HotPadsItem>({
    actorId: HOTPADS_ACTOR,
    variants,
    urlFor: hotPadsSearchUrl,
    mapItem: mapHotPads,
  })
}

// =================================================================================
// RentHop
// =================================================================================
// Why this actor: RentHop is NYC-native and ranks by "HopScore" which surfaces
// fresh-listed, no-fee inventory. Lots of NYC-only listings that never make it
// to national aggregators. `epctex~renthop-scraper` follows the same vendor
// shape as the rest of the suite.
// Expected output volume: 30-120/sweep.

const RENTHOP_ACTOR = process.env.APIFY_RENTHOP_ACTOR ?? 'epctex~renthop-scraper'

type RentHopItem = {
  url?: string
  detailUrl?: string
  address?: string
  city?: string
  state?: string
  zip?: string
  price?: number | string
  bedrooms?: number
  bathrooms?: number
  squareFeet?: number
  description?: string
  photos?: unknown
  images?: unknown
  neighborhood?: string
  noFee?: boolean
  agentName?: string
  agentPhone?: string
  agentEmail?: string
  brokerage?: string
  amenities?: unknown
  datePosted?: string
  latitude?: number
  longitude?: number
}

function rentHopSearchUrl(v: Variant): string {
  // RentHop: https://www.renthop.com/search/<area>?...
  const base = 'https://www.renthop.com/search'
  let area = 'nyc'
  if (v.borough) area = slugify(v.borough)
  if (v.neighborhood) area = slugify(v.neighborhood)
  const params = new URLSearchParams()
  if (v.beds != null) params.set('min_bedrooms', String(v.beds))
  if (v.budgetMax) params.set('max_price', String(v.budgetMax))
  const qs = params.toString()
  return `${base}/${area}${qs ? `?${qs}` : ''}`
}

function mapRentHop(item: RentHopItem, v: Variant): NewListing | null {
  const url = item.url ?? item.detailUrl
  if (!url) return null
  const photos = asPhotoArray(item.photos) || asPhotoArray(item.images)
  const amenities = Array.isArray(item.amenities)
    ? (item.amenities.filter((a) => typeof a === 'string') as string[])
    : []
  return {
    source: 'renthop',
    source_url: url,
    title: item.address ?? 'RentHop listing',
    description: item.description ?? null,
    price_monthly: asNumber(item.price),
    beds: item.bedrooms != null ? item.bedrooms.toString() : null,
    baths: item.bathrooms != null ? item.bathrooms.toString() : null,
    sqft: item.squareFeet ?? null,
    photos,
    amenities,
    address: item.address ?? null,
    neighborhood: item.neighborhood ?? v.neighborhood ?? null,
    borough: v.borough ?? item.city ?? null,
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
      broker_fee_text: item.noFee ? 'no fee' : undefined,
    },
    posted_at: asDate(item.datePosted),
    is_active: true,
    raw: { actor: RENTHOP_ACTOR, variant: v.label, item: item as unknown },
  }
}

export async function runRentHopSearchNYC(): Promise<NewListing[]> {
  const variants = await buildVariants()
  return runVariantSweep<RentHopItem>({
    actorId: RENTHOP_ACTOR,
    variants,
    urlFor: rentHopSearchUrl,
    mapItem: mapRentHop,
  })
}

// =================================================================================
// Twitter / X — NYC apartment-listing accounts
// =================================================================================
// Why this actor: there's a small but high-signal cohort of NYC accounts that
// tweet listings (often before they hit StreetEasy / Zillow). `apidojo~twitter-scraper-lite`
// is the free-tier-friendly alternative to the now-paid `apify~twitter-scraper`.
// We don't try to extract structured listing fields here — we lean on Haiku to
// parse the tweet text in `src/agents/extract.ts` if/when these flow through.
// For v0 we just capture the tweet URL + body + photos and let the extract agent
// promote them to listings on demand.
//
// Variant strategy: NOT borough/bed/neighborhood — each variant is one account.
// Override the account list via `APIFY_TWITTER_HANDLES` (comma-separated).

const TWITTER_ACTOR = process.env.APIFY_TWITTER_ACTOR ?? 'apidojo~twitter-scraper-lite'

const DEFAULT_TWITTER_HANDLES = [
  'nybedfindr',
  'bushwickbb',
  'brooklyn_housing',
  'nyc_listings',
  'nofeenyc',
] as const

type TweetItem = {
  url?: string
  tweetUrl?: string
  id?: string
  text?: string
  full_text?: string
  user?: { screen_name?: string; name?: string }
  author?: { userName?: string; name?: string }
  createdAt?: string
  created_at?: string
  media?: Array<{ media_url_https?: string; url?: string; type?: string }>
  photos?: unknown
}

function tweetUrl(item: TweetItem): string | null {
  if (item.url) return item.url
  if (item.tweetUrl) return item.tweetUrl
  const handle = item.user?.screen_name ?? item.author?.userName
  if (handle && item.id) return `https://twitter.com/${handle}/status/${item.id}`
  return null
}

function mapTweet(item: TweetItem): NewListing | null {
  const url = tweetUrl(item)
  if (!url) return null
  const text = item.text ?? item.full_text ?? ''
  if (!text.trim()) return null
  // Cheap pre-filter: must mention rent/apartment/sublet/lease + a $ amount or
  // a borough name. Tweets without any of these are almost never offers.
  const t = text.toLowerCase()
  if (!/(apartment|apt|rent|sublet|lease|bedroom|studio)/.test(t)) return null
  if (!/\$|brooklyn|manhattan|queens|bronx/.test(t)) return null

  const photos = Array.isArray(item.media)
    ? item.media
        .map((m) => m?.media_url_https ?? m?.url)
        .filter((u): u is string => typeof u === 'string')
    : asPhotoArray(item.photos)

  const handle = item.user?.screen_name ?? item.author?.userName ?? null
  const name = item.user?.name ?? item.author?.name ?? null
  return {
    source: 'twitter',
    source_url: url,
    title: text.split('\n')[0]?.slice(0, 200) || `Tweet from @${handle ?? 'unknown'}`,
    description: text,
    photos,
    posted_at: asDate(item.createdAt) ?? asDate(item.created_at),
    is_active: true,
    contact: {
      name: name ?? undefined,
      website: handle ? `https://twitter.com/${handle}` : undefined,
      preferred_method: 'website',
    },
    raw: { actor: TWITTER_ACTOR, handle, item: item as unknown },
  }
}

export async function runTwitterSearchNYC(): Promise<NewListing[]> {
  const t = token()
  if (!t) return []
  // Variant strategy here is per-handle, not per-borough/bed.
  const handles = (process.env.APIFY_TWITTER_HANDLES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const list = handles.length ? handles : [...DEFAULT_TWITTER_HANDLES]
  const cap = budgetMode() === 'aggressive' ? list.length : Math.min(list.length, 3)
  const picked = list.slice(0, cap)
  const out: NewListing[] = []
  for (const handle of picked) {
    const items = await runApifyActor<TweetItem>(TWITTER_ACTOR, {
      handles: [handle],
      tweetsDesired: 50,
      // apidojo's lite actor accepts both `handles` and `searchTerms` — keep both
      // so a forked actor still works.
      searchTerms: [`from:${handle}`],
      maxTweets: 50,
    })
    for (const it of items) {
      const mapped = mapTweet(it)
      if (mapped) out.push(mapped)
    }
  }
  return dedupeByUrl(out)
}

// =================================================================================
// Diagnostics
// =================================================================================

/**
 * Returns the active budget mode. Useful for logging / `/admin` telemetry so we
 * can tell at a glance whether the cron is running aggressive or light.
 */
export function activeBudgetMode(): BudgetMode {
  return budgetMode()
}
