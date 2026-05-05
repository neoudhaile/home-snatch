import { getRankedFeed, type FeedFilters } from '@/lib/feed-data'
import { FeedShell } from '@/components/feed/feed-shell'
import {
  parseSearchQuery,
  extendFeedFilters,
  type ExtractedFilters,
  type FilterChipKey,
} from '@/lib/search'
import { hashProfileSet, loadAllProfileFiles, mergeProfileConstraints } from '@/lib/profile-set'

type SearchParams = Promise<{
  q?: string
  drop?: string
  /** Comma-separated neighborhoods to filter to (overrides the joint default). */
  neighborhoods?: string
  /** When `1`, bypass the auto-filter to joint preferred_areas. */
  show_all?: string
  /** When `1`, render the post-setup welcome banner. */
  welcome?: string
}>

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
  const showAll = sp.show_all === '1'
  const showWelcome = sp.welcome === '1'

  // Compute joint preferred_areas from src/profiles/. Never throws; returns
  // empty when no profiles are configured.
  const profiles = await loadAllProfileFiles().catch(() => [])
  const joint = mergeProfileConstraints(profiles)
  const jointAreas = joint.preferred_areas
  // Stable hash of the on-disk profile set. Listings whose latest score has a
  // different `profile_set_hash` are mid-rescore — surfaced via a "scoring..."
  // shimmer on the score badge so the user knows the rank is in flight.
  const currentProfileHash = profiles.length > 0 ? hashProfileSet(profiles) : ''

  // Resolve the effective neighborhood filter:
  //   1. Explicit `?neighborhoods=foo,bar` always wins.
  //   2. `?show_all=1` opts out of the joint-areas default.
  //   3. Otherwise, default to joint preferred_areas (if any).
  const explicitNbhds = (sp.neighborhoods ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const effectiveNeighborhoods: string[] | undefined =
    explicitNbhds.length > 0
      ? explicitNbhds
      : showAll || jointAreas.length === 0
        ? undefined
        : jointAreas
  const usingDefaultAreas =
    !showAll && explicitNbhds.length === 0 && jointAreas.length > 0

  // No query → existing behavior, plus the area default + welcome banner.
  if (!rawQuery) {
    const listings = await getRankedFeed({
      freshnessDays: 30,
      neighborhoods: effectiveNeighborhoods,
    })
    return (
      <FeedShell
        initial={listings}
        jointAreas={jointAreas}
        usingDefaultAreas={usingDefaultAreas}
        showWelcome={showWelcome}
        currentProfileHash={currentProfileHash}
      />
    )
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
      // The user-typed query takes priority over the profile area default —
      // search is an explicit "show me X" gesture, not a passive feed.
      neighborhoods: explicitNbhds.length > 0 ? explicitNbhds : undefined,
    })
    return (
      <FeedShell
        initial={listings}
        searchQuery={rawQuery}
        searchFilters={dropped}
        jointAreas={jointAreas}
        usingDefaultAreas={false}
        showWelcome={showWelcome}
        currentProfileHash={currentProfileHash}
      />
    )
  }

  const effective = applyDrops(extracted, drop)
  // Build the rich filter set and run the feed. Search overrides the area
  // default — the user's NL query / chips win.
  const base: FeedFilters = {
    freshnessDays: 30,
    neighborhoods: explicitNbhds.length > 0 ? explicitNbhds : undefined,
  }
  const filters = extendFeedFilters(base, effective)
  const listings = await getRankedFeed(filters)

  return (
    <FeedShell
      initial={listings}
      searchQuery={rawQuery}
      searchFilters={effective}
      jointAreas={jointAreas}
      usingDefaultAreas={false}
      showWelcome={showWelcome}
      currentProfileHash={currentProfileHash}
    />
  )
}
