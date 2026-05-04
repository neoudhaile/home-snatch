import { getRankedFeed, type FeedFilters } from '@/lib/feed-data'
import { FeedShell } from '@/components/feed/feed-shell'
import {
  parseSearchQuery,
  extendFeedFilters,
  type ExtractedFilters,
  type FilterChipKey,
} from '@/lib/search'

type SearchParams = Promise<{ q?: string; drop?: string }>

export const dynamic = 'force-dynamic'

const DROP_KEYS: ReadonlyArray<FilterChipKey> = [
  'price',
  'beds',
  'boroughs',
  'neighborhoods',
  'sources',
  'mustHave',
  'freshness',
  'noBrokerFee',
  'rentStabilized',
  'petFriendly',
  'furnished',
  'keywords',
]

function applyDrops(filters: ExtractedFilters, drop: Set<FilterChipKey>): ExtractedFilters {
  const out: ExtractedFilters = { ...filters }
  if (drop.has('price')) {
    out.price_min = null
    out.price_max = null
  }
  if (drop.has('beds')) {
    out.beds_min = null
    out.beds_max = null
  }
  if (drop.has('boroughs')) out.boroughs = null
  if (drop.has('neighborhoods')) out.neighborhoods = null
  if (drop.has('sources')) out.sources = null
  if (drop.has('mustHave')) out.must_have_amenities = null
  if (drop.has('freshness')) out.max_freshness_days = null
  if (drop.has('noBrokerFee')) out.no_broker_fee = null
  if (drop.has('rentStabilized')) out.rent_stabilized_only = null
  if (drop.has('petFriendly')) out.pet_friendly = null
  if (drop.has('furnished')) out.furnished = null
  if (drop.has('keywords')) out.keywords = null
  return out
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const sp = await searchParams
  const rawQuery = (sp.q ?? '').trim()

  // No query → existing behavior unchanged.
  if (!rawQuery) {
    const listings = await getRankedFeed({ freshnessDays: 30 })
    return <FeedShell initial={listings} />
  }

  // Parse the `drop` param (chip-removal state).
  const dropRaw = (sp.drop ?? '').trim()
  const drop = new Set<FilterChipKey>(
    dropRaw
      .split(',')
      .map((s) => s.trim())
      .filter((s): s is FilterChipKey => (DROP_KEYS as readonly string[]).includes(s))
  )

  // With a query → run extraction server-side.
  let extracted: ExtractedFilters | null = null
  try {
    extracted = await parseSearchQuery(rawQuery)
  } catch (err) {
    console.warn('[page] parseSearchQuery failed, falling back to keyword-only:', (err as Error).message)
  }

  if (!extracted) {
    // Extraction failed (no API key, network err, etc.) — degrade to a
    // keyword-only AND-match against the unfiltered feed using the raw query.
    const fallbackFilters: ExtractedFilters = {
      intent_summary: rawQuery,
      keywords: [rawQuery],
    }
    const dropped = applyDrops(fallbackFilters, drop)
    const listings = await getRankedFeed({
      freshnessDays: 30,
      keywords: dropped.keywords ?? undefined,
      query: rawQuery,
    })
    return (
      <FeedShell
        initial={listings}
        searchQuery={rawQuery}
        searchFilters={dropped}
      />
    )
  }

  const effective = applyDrops(extracted, drop)
  // Build the rich filter set and run the feed.
  const base: FeedFilters = { freshnessDays: 30 }
  const filters = extendFeedFilters(base, effective)
  const listings = await getRankedFeed(filters)

  return (
    <FeedShell
      initial={listings}
      searchQuery={rawQuery}
      searchFilters={effective}
    />
  )
}
