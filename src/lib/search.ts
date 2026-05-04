/**
 * Natural-language search — parsing + filter application.
 *
 * Pipeline:
 *   1. The user types something like "1br under $3k in Brooklyn near a coffee
 *      shop, no broker fee, posted this week" into the header search bar.
 *   2. `parseSearchQuery` (server-side) calls Haiku 4.5 with a forced tool-use
 *      against `EXTRACT_FILTERS_SCHEMA` to derive a structured `ExtractedFilters`.
 *   3. `extendFeedFilters` merges those into the existing `FeedFilters` shape
 *      (in `lib/feed-data.ts`), preserving `freshnessDays` / `sources` for
 *      backward compat and adding the new fields on top.
 *   4. `applyKeywordFilter` does a case-insensitive AND-match across
 *      title + description + amenities + neighborhood, used by the consumer
 *      after the DB read.
 *
 * The Zod schema and the JSON schema are hand-kept in sync. Zod is the
 * runtime validator (used in the API route), JSON schema is what we hand to
 * Haiku in the tool-use call. If you edit one, edit the other.
 */
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { SOURCES, type Source } from '@/types'
import type { FeedFilters } from '@/lib/feed-data'

// ---------- borough canonical list ----------

export const BOROUGHS = ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] as const
export type Borough = (typeof BOROUGHS)[number]

// ---------- Zod schema (runtime + type source of truth) ----------

export const ExtractedFiltersSchema = z.object({
  price_min: z.number().nullable().optional(),
  price_max: z.number().nullable().optional(),
  beds_min: z.number().nullable().optional(),
  beds_max: z.number().nullable().optional(),
  boroughs: z.array(z.enum(BOROUGHS)).nullable().optional(),
  neighborhoods: z.array(z.string()).nullable().optional(),
  sources: z.array(z.enum(SOURCES)).nullable().optional(),
  must_have_amenities: z.array(z.string()).nullable().optional(),
  deal_breakers: z.array(z.string()).nullable().optional(),
  max_freshness_days: z.number().nullable().optional(),
  no_broker_fee: z.boolean().nullable().optional(),
  rent_stabilized_only: z.boolean().nullable().optional(),
  pet_friendly: z.boolean().nullable().optional(),
  furnished: z.boolean().nullable().optional(),
  keywords: z.array(z.string()).nullable().optional(),
  intent_summary: z.string().min(1),
})

export type ExtractedFilters = z.infer<typeof ExtractedFiltersSchema>

// ---------- JSON schema for Haiku tool-use (kept in sync with Zod above) ----------

export const EXTRACT_FILTERS_TOOL: Anthropic.Tool = {
  name: 'extract_filters',
  description: 'Extract structured filters from a NL apartment search query',
  input_schema: {
    type: 'object',
    properties: {
      price_min: {
        type: ['number', 'null'],
        description: 'in USD/mo, null if not specified',
      },
      price_max: { type: ['number', 'null'] },
      beds_min: {
        type: ['number', 'null'],
        description: '0 = studio',
      },
      beds_max: { type: ['number', 'null'] },
      boroughs: {
        type: ['array', 'null'],
        items: { enum: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'] },
      },
      neighborhoods: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'NYC neighborhoods (West Village, Bed-Stuy, etc.)',
      },
      sources: {
        type: ['array', 'null'],
        items: {
          enum: ['craigslist', 'reddit', 'listings-project', 'streeteasy', 'zillow', 'trulia', 'apartments', 'manual'],
        },
      },
      must_have_amenities: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description: 'e.g. dishwasher, in-unit-laundry, doorman, gym',
      },
      deal_breakers: {
        type: ['array', 'null'],
        items: { type: 'string' },
      },
      max_freshness_days: {
        type: ['number', 'null'],
        description: '1, 7, 14, 30, or null',
      },
      no_broker_fee: { type: ['boolean', 'null'] },
      rent_stabilized_only: { type: ['boolean', 'null'] },
      pet_friendly: { type: ['boolean', 'null'] },
      furnished: { type: ['boolean', 'null'] },
      keywords: {
        type: ['array', 'null'],
        items: { type: 'string' },
        description:
          'free-text terms to match against listing title/description (e.g. "coffee shop", "south-facing", "duplex"). The DB ranker uses these against text fields.',
      },
      intent_summary: {
        type: 'string',
        description: 'one short sentence echoing the user query, surfaced in the UI as "Searching for: ...".',
      },
    },
    required: ['intent_summary'],
  },
}

// ---------- system prompt (cached) ----------

export const SEARCH_EXTRACTION_SYSTEM_PROMPT = `Extract structured filters from a NYC apartment search query. Be conservative — only fill fields the user actually said or strongly implied. Map natural-language phrasing to canonical values: 'BK' / 'Bk' / 'B-K' → 'Brooklyn'. 'studio' → beds_min=0,beds_max=0. 'no broker fee' → no_broker_fee=true. 'this week' → max_freshness_days=7. 'recent' → max_freshness_days=14. Don't add filters the user didn't ask for.

Examples:

Query: "1br under $3k in Brooklyn near a coffee shop, no broker fee, posted this week"
Filters: { price_max: 3000, beds_min: 1, beds_max: 1, boroughs: ["Brooklyn"], no_broker_fee: true, max_freshness_days: 7, keywords: ["coffee shop"], intent_summary: "1br Brooklyn under $3k, no broker fee, posted this week" }
(Don't add price_min, neighborhoods, sources, pet_friendly, furnished, rent_stabilized_only, must_have_amenities, deal_breakers — the user didn't say.)

Query: "studio in the West Village or East Village, dog-friendly"
Filters: { beds_min: 0, beds_max: 0, neighborhoods: ["West Village", "East Village"], pet_friendly: true, intent_summary: "studio in West Village or East Village, dog-friendly" }
(Don't add boroughs — neighborhoods are more specific. Don't infer price.)

Query: "anything with a dishwasher and in-unit laundry"
Filters: { must_have_amenities: ["dishwasher", "in-unit-laundry"], intent_summary: "anything with a dishwasher and in-unit laundry" }
(Don't add boroughs, beds, price — the user truly said "anything".)`

// ---------- parser (calls Haiku) ----------

/**
 * Server-side: takes the raw user query, returns the structured filters.
 * Throws on Anthropic API errors so the caller can decide whether to fall
 * back to an unfiltered feed.
 */
export async function parseSearchQuery(query: string): Promise<ExtractedFilters> {
  const trimmed = query.trim()
  if (!trimmed) {
    return { intent_summary: '' }
  }

  // Lazy import so this file stays cheap to import on the client.
  const { getAnthropic, MODELS } = await import('@/lib/anthropic')
  const client = getAnthropic()

  const resp = await client.messages.create({
    model: MODELS.extract,
    max_tokens: 1024,
    tools: [EXTRACT_FILTERS_TOOL],
    tool_choice: { type: 'tool', name: 'extract_filters' },
    system: [
      {
        type: 'text',
        text: SEARCH_EXTRACTION_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: `Query: ${trimmed}` }],
  })

  const block = resp.content.find((b) => b.type === 'tool_use')
  if (!block || block.type !== 'tool_use') {
    return { intent_summary: trimmed }
  }
  const parsed = ExtractedFiltersSchema.safeParse(block.input)
  if (!parsed.success) {
    console.warn('[search] extracted filters failed Zod parse:', parsed.error.message)
    return { intent_summary: trimmed }
  }
  // Make sure intent_summary is non-empty (Haiku is required to fill it, but
  // belt-and-suspenders for short queries).
  if (!parsed.data.intent_summary || parsed.data.intent_summary.trim() === '') {
    return { ...parsed.data, intent_summary: trimmed }
  }
  return parsed.data
}

// ---------- keyword filter (AND-match) ----------

/**
 * Returns listings where EVERY keyword (case-insensitive) appears in
 * `title + description + amenities + neighborhood`. AND, not OR.
 * Empty keywords list → returns input untouched.
 */
export function applyKeywordFilter<T extends {
  title: string | null
  description: string | null
  amenities?: string[] | null
  neighborhood: string | null
}>(listings: T[], keywords: string[] | null | undefined): T[] {
  if (!keywords || keywords.length === 0) return listings
  const needles = keywords
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0)
  if (needles.length === 0) return listings
  return listings.filter((l) => {
    const hay = [
      l.title ?? '',
      l.description ?? '',
      (l.amenities ?? []).join(' '),
      l.neighborhood ?? '',
    ]
      .join(' ')
      .toLowerCase()
    return needles.every((n) => hay.includes(n))
  })
}

// ---------- merge into FeedFilters ----------

/**
 * Map the 1-or-7-or-14-or-30 freshness slider over an arbitrary
 * `max_freshness_days`. Keeps the UI selector honest.
 */
function snapFreshnessDays(d: number | null | undefined): 1 | 7 | 14 | 30 | undefined {
  if (d == null) return undefined
  if (d <= 1) return 1
  if (d <= 7) return 7
  if (d <= 14) return 14
  return 30
}

/**
 * Take a base FeedFilters (typically `{}` for a fresh search) and an
 * `ExtractedFilters` from Haiku. Returns a new FeedFilters with the new
 * fields set. Backward-compatible: existing fields (`freshnessDays`,
 * `sources`) are preserved if not overridden by the extraction.
 */
export function extendFeedFilters(
  base: FeedFilters,
  extracted: ExtractedFilters
): FeedFilters {
  const out: FeedFilters = { ...base }

  // Freshness: extracted overrides base if set.
  const freshness = snapFreshnessDays(extracted.max_freshness_days)
  if (freshness != null) out.freshnessDays = freshness

  // Sources: extracted overrides if set.
  if (extracted.sources && extracted.sources.length > 0) {
    out.sources = extracted.sources as Source[]
  }

  if (extracted.price_min != null) out.priceMin = extracted.price_min
  if (extracted.price_max != null) out.priceMax = extracted.price_max
  if (extracted.beds_min != null) out.bedsMin = extracted.beds_min
  if (extracted.beds_max != null) out.bedsMax = extracted.beds_max

  if (extracted.boroughs && extracted.boroughs.length > 0) {
    out.boroughs = extracted.boroughs as Borough[]
  }
  if (extracted.neighborhoods && extracted.neighborhoods.length > 0) {
    out.neighborhoods = extracted.neighborhoods
  }
  if (extracted.must_have_amenities && extracted.must_have_amenities.length > 0) {
    out.mustHave = extracted.must_have_amenities
  }
  if (extracted.no_broker_fee != null) out.noBrokerFee = extracted.no_broker_fee
  if (extracted.rent_stabilized_only != null) out.rentStabilizedOnly = extracted.rent_stabilized_only
  if (extracted.pet_friendly != null) out.petFriendly = extracted.pet_friendly
  if (extracted.furnished != null) out.furnished = extracted.furnished
  if (extracted.keywords && extracted.keywords.length > 0) {
    out.keywords = extracted.keywords
  }
  out.query = extracted.intent_summary
  return out
}

// ---------- helpers for chip removal in UI ----------

export type FilterChipKey =
  | 'price'
  | 'beds'
  | 'boroughs'
  | 'neighborhoods'
  | 'sources'
  | 'mustHave'
  | 'freshness'
  | 'noBrokerFee'
  | 'rentStabilized'
  | 'petFriendly'
  | 'furnished'
  | 'keywords'

/**
 * Render an `ExtractedFilters` as a flat list of removable chips.
 * Each chip carries a key (so the consumer can drop just that field).
 */
export function filtersToChips(f: ExtractedFilters): { key: FilterChipKey; label: string }[] {
  const chips: { key: FilterChipKey; label: string }[] = []
  const priceMin = f.price_min
  const priceMax = f.price_max
  if (priceMin != null && priceMax != null) {
    chips.push({ key: 'price', label: `$${priceMin.toLocaleString()}–$${priceMax.toLocaleString()}` })
  } else if (priceMax != null) {
    chips.push({ key: 'price', label: `under $${priceMax.toLocaleString()}` })
  } else if (priceMin != null) {
    chips.push({ key: 'price', label: `over $${priceMin.toLocaleString()}` })
  }
  const bedsMin = f.beds_min
  const bedsMax = f.beds_max
  if (bedsMin === 0 && bedsMax === 0) {
    chips.push({ key: 'beds', label: 'studio' })
  } else if (bedsMin != null && bedsMax != null && bedsMin === bedsMax) {
    chips.push({ key: 'beds', label: `${bedsMin}br` })
  } else if (bedsMin != null && bedsMax != null) {
    chips.push({ key: 'beds', label: `${bedsMin}–${bedsMax}br` })
  } else if (bedsMin != null) {
    chips.push({ key: 'beds', label: `${bedsMin}+ br` })
  } else if (bedsMax != null) {
    chips.push({ key: 'beds', label: `up to ${bedsMax}br` })
  }
  if (f.boroughs && f.boroughs.length > 0) {
    chips.push({ key: 'boroughs', label: f.boroughs.join(', ') })
  }
  if (f.neighborhoods && f.neighborhoods.length > 0) {
    chips.push({ key: 'neighborhoods', label: f.neighborhoods.join(', ') })
  }
  if (f.sources && f.sources.length > 0) {
    chips.push({ key: 'sources', label: f.sources.join(', ') })
  }
  if (f.must_have_amenities && f.must_have_amenities.length > 0) {
    chips.push({ key: 'mustHave', label: f.must_have_amenities.join(', ') })
  }
  if (f.max_freshness_days != null) {
    chips.push({ key: 'freshness', label: `≤${f.max_freshness_days}d old` })
  }
  if (f.no_broker_fee) chips.push({ key: 'noBrokerFee', label: 'no broker fee' })
  if (f.rent_stabilized_only) chips.push({ key: 'rentStabilized', label: 'rent-stabilized' })
  if (f.pet_friendly) chips.push({ key: 'petFriendly', label: 'pet-friendly' })
  if (f.furnished) chips.push({ key: 'furnished', label: 'furnished' })
  if (f.keywords && f.keywords.length > 0) {
    for (const kw of f.keywords) {
      chips.push({ key: 'keywords', label: `"${kw}"` })
    }
  }
  return chips
}
