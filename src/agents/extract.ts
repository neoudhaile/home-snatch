/**
 * Extraction agent — turns arbitrary HTML/JSON pages into a `NewListing`.
 *
 * Strategy:
 *   1. Force a Haiku tool-call against a JSON schema mirroring `NewListing`.
 *   2. Cache the system prompt with `cache_control: ephemeral`.
 *   3. `extractFromUrl` adds a 3-tier fetch: direct → Browserless → Apify
 *      (URL-host-keyed) → null.
 *
 * The schema is intentionally narrower than the DB row (no DB-managed fields
 * like `id`, `fetched_at`, etc.) and uses `["string", "null"]` so the model can
 * cleanly say "I don't know".
 */

import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import type { NewListing, Source } from '@/types'
import {
  runApartmentsSearchNYC,
  runStreeteasySearchNYC,
  runTruliaSearchNYC,
  runZillowSearchNYC,
} from '@/scrapers/apify'
import { browserlessConfigured, fetchViaBrowserless } from '@/scrapers/browserless'
import { logScrapeError, throttledFetch } from '@/scrapers/_util'

const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'emit_listing',
  description:
    'Emit the structured apartment-listing fields you extracted from the page. Return null for any field you are uncertain about. Never fabricate. Photos must be absolute URLs that appear on the page.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      description: { type: ['string', 'null'] },
      price_monthly: { type: ['integer', 'null'] },
      beds: {
        type: ['number', 'null'],
        description: 'Number of bedrooms; 0 for studio.',
      },
      baths: { type: ['number', 'null'] },
      sqft: { type: ['integer', 'null'] },
      available_date: {
        type: ['string', 'null'],
        description: 'ISO 8601 date if explicit on page, else null.',
      },
      lease_term: { type: ['string', 'null'] },
      furnished: { type: ['boolean', 'null'] },
      pet_friendly: { type: ['boolean', 'null'] },
      amenities: { type: 'array', items: { type: 'string' } },
      photos: {
        type: 'array',
        items: { type: 'string' },
        description: 'Absolute URLs only; reject relative paths.',
      },
      address: { type: ['string', 'null'] },
      unit: { type: ['string', 'null'] },
      neighborhood: { type: ['string', 'null'] },
      borough: { type: ['string', 'null'] },
      zip: { type: ['string', 'null'] },
      lat: { type: ['number', 'null'] },
      lng: { type: ['number', 'null'] },
      contact: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          agency: { type: ['string', 'null'] },
          website: { type: ['string', 'null'] },
          preferred_method: {
            type: ['string', 'null'],
            enum: ['phone', 'email', 'website', 'in-person', null],
          },
        },
      },
      application: {
        type: 'object',
        properties: {
          url: { type: ['string', 'null'] },
          requirements: { type: ['string', 'null'] },
          fee: { type: ['integer', 'null'] },
          broker_fee_pct: { type: ['number', 'null'] },
          broker_fee_text: { type: ['string', 'null'] },
          required_docs: { type: 'array', items: { type: 'string' } },
          notes: { type: ['string', 'null'] },
        },
      },
      posted_at: {
        type: ['string', 'null'],
        description: 'ISO 8601 timestamp from the page; null if not stated.',
      },
    },
    required: ['title', 'photos', 'amenities'],
  },
}

type ExtractedFields = {
  title: string
  description: string | null
  price_monthly: number | null
  beds: number | null
  baths: number | null
  sqft: number | null
  available_date: string | null
  lease_term: string | null
  furnished: boolean | null
  pet_friendly: boolean | null
  amenities: string[]
  photos: string[]
  address: string | null
  unit: string | null
  neighborhood: string | null
  borough: string | null
  zip: string | null
  lat: number | null
  lng: number | null
  contact?: {
    name?: string | null
    phone?: string | null
    email?: string | null
    agency?: string | null
    website?: string | null
    preferred_method?: 'phone' | 'email' | 'website' | 'in-person' | null
  }
  application?: {
    url?: string | null
    requirements?: string | null
    fee?: number | null
    broker_fee_pct?: number | null
    broker_fee_text?: string | null
    required_docs?: string[]
    notes?: string | null
  }
  posted_at: string | null
}

const SYSTEM_PROMPT =
  'You extract structured NYC apartment-listing fields from raw HTML or text. Rules: ' +
  '(1) Return null for any field that is not explicitly stated. Never guess. ' +
  '(2) Photos must be absolute URLs (http/https) drawn from the page — no relative paths, no placeholders. ' +
  '(3) `posted_at` must be an ISO 8601 timestamp drawn from the page (e.g. <time datetime>); if no posting date is stated, return null. ' +
  '(4) Strip real-estate hype language ("luxury", "stunning", "must see") from descriptions; keep concrete facts. ' +
  '(5) `beds=0` means studio. ' +
  '(6) Capture broker fee verbatim if numeric ("15%", "1 month") and set `broker_fee_pct=0` only when the page literally says "no fee" or equivalent. ' +
  'Use the emit_listing tool for your response.'

/** Trim HTML for the model — drop scripts/styles, collapse whitespace. */
function trimHtml(html: string, maxChars = 60_000): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return stripped.length > maxChars ? stripped.slice(0, maxChars) : stripped
}

/** Best-effort `Source` from URL host. Falls back to `manual`. */
export function sourceFromUrl(url: string): Source {
  try {
    const host = new URL(url).host.toLowerCase()
    if (/zillow\.com$/.test(host) || host === 'zillow.com') return 'zillow'
    if (/streeteasy\.com$/.test(host) || host === 'streeteasy.com') return 'streeteasy'
    if (/trulia\.com$/.test(host) || host === 'trulia.com') return 'trulia'
    if (/apartments\.com$/.test(host) || host === 'apartments.com') return 'apartments'
    if (/craigslist\.org$/.test(host)) return 'craigslist'
    if (/(?:^|\.)reddit\.com$/.test(host)) return 'reddit'
    if (/listingsproject\.com$/.test(host)) return 'listings-project'
  } catch {
    // ignore
  }
  return 'manual'
}

export async function extractListingFromHTML(
  url: string,
  html: string,
  opts: { hint?: string } = {}
): Promise<NewListing | null> {
  const anthropic = getAnthropic()
  const userText = [
    `URL: ${url}`,
    opts.hint ? `Hint: ${opts.hint}` : '',
    '',
    'Page content (HTML, scripts/styles stripped):',
    trimHtml(html),
  ]
    .filter(Boolean)
    .join('\n')

  let fields: ExtractedFields | null = null
  try {
    const resp = await anthropic.messages.create({
      model: MODELS.extract,
      max_tokens: 2048,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'tool', name: 'emit_listing' },
      system: [
        {
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: userText }],
    })
    const block = resp.content.find((c) => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') return null
    fields = block.input as ExtractedFields
  } catch (err) {
    logScrapeError('extract', url, err)
    return null
  }

  if (!fields || !fields.title) return null

  // Filter photos: must be absolute and image-y.
  const photos = (fields.photos ?? []).filter(
    (p) => typeof p === 'string' && /^https?:\/\//.test(p)
  )

  const posted_at =
    fields.posted_at && !Number.isNaN(new Date(fields.posted_at).getTime())
      ? new Date(fields.posted_at)
      : null
  const available_date =
    fields.available_date && !Number.isNaN(new Date(fields.available_date).getTime())
      ? new Date(fields.available_date)
      : null

  // contact / application: keep only when at least one field is set.
  const c = fields.contact ?? {}
  const cFiltered = {
    name: c.name ?? undefined,
    phone: c.phone ?? undefined,
    email: c.email ?? undefined,
    agency: c.agency ?? undefined,
    website: c.website ?? undefined,
    preferred_method: c.preferred_method ?? undefined,
  }
  const hasContact = Object.values(cFiltered).some((v) => v != null)

  const a = fields.application ?? {}
  const aFiltered = {
    url: a.url ?? undefined,
    requirements: a.requirements ?? undefined,
    fee: a.fee ?? undefined,
    broker_fee_pct: a.broker_fee_pct ?? undefined,
    broker_fee_text: a.broker_fee_text ?? undefined,
    required_docs: a.required_docs ?? undefined,
    notes: a.notes ?? undefined,
  }
  const hasApp = Object.values(aFiltered).some(
    (v) => v != null && (Array.isArray(v) ? v.length > 0 : true)
  )

  return {
    source: sourceFromUrl(url),
    source_url: url,
    title: fields.title,
    description: fields.description,
    price_monthly: fields.price_monthly,
    beds: fields.beds != null ? fields.beds.toString() : null,
    baths: fields.baths != null ? fields.baths.toString() : null,
    sqft: fields.sqft,
    available_date,
    lease_term: fields.lease_term,
    furnished: fields.furnished,
    pet_friendly: fields.pet_friendly,
    amenities: fields.amenities ?? [],
    photos,
    address: fields.address,
    unit: fields.unit,
    neighborhood: fields.neighborhood,
    borough: fields.borough,
    zip: fields.zip,
    lat: fields.lat,
    lng: fields.lng,
    contact: hasContact ? cFiltered : undefined,
    application: hasApp ? aFiltered : undefined,
    posted_at,
    is_active: true,
    raw: { extractor: 'haiku-4.5', source_url: url },
  }
}

/** True if the host likely blocks direct fetch (CDN-fronted real-estate sites). */
function isHardBlockHost(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase()
    return /(?:^|\.)(?:zillow|streeteasy|trulia|apartments|realtor)\.com$/.test(host)
  } catch {
    return false
  }
}

/** Per-host Apify routing. Each runner ignores its input and pulls a search slate;
 * we filter the output to a record whose `source_url` matches the requested URL.
 * If no match, we return null and the caller can degrade.
 */
async function tryApifyForUrl(url: string): Promise<NewListing | null> {
  const host = new URL(url).host.toLowerCase()
  let candidates: NewListing[] = []
  if (/zillow\.com$/.test(host)) candidates = await runZillowSearchNYC()
  else if (/streeteasy\.com$/.test(host)) candidates = await runStreeteasySearchNYC()
  else if (/trulia\.com$/.test(host)) candidates = await runTruliaSearchNYC()
  else if (/apartments\.com$/.test(host)) candidates = await runApartmentsSearchNYC()
  else return null

  return candidates.find((c) => c.source_url === url) ?? null
}

/**
 * Fetch + extract for a single URL. Tier order:
 *   1. Direct fetch with browser UA (works for Craigslist / Reddit / LP).
 *   2. Browserless rendered HTML (when token configured).
 *   3. Apify per-host search (best-effort match by URL).
 *
 * Returns null when no tier could yield a listing.
 */
export async function extractFromUrl(url: string): Promise<NewListing | null> {
  // Tier 1: direct fetch (skipped for hard-block hosts — saves a useless 403).
  if (!isHardBlockHost(url)) {
    try {
      const res = await throttledFetch(url)
      if (res.ok) {
        const html = await res.text()
        const parsed = await extractListingFromHTML(url, html)
        if (parsed) return parsed
      }
    } catch (err) {
      logScrapeError('extract', url, err)
    }
  }

  // Tier 2: Browserless.
  if (browserlessConfigured()) {
    const html = await fetchViaBrowserless(url)
    if (html) {
      const parsed = await extractListingFromHTML(url, html)
      if (parsed) return parsed
    }
  }

  // Tier 3: Apify per-host.
  return tryApifyForUrl(url)
}
