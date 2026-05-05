import { after } from 'next/server'
import { revalidateTag } from 'next/cache'
import { getRankedFeedWithCounts, type FeedFilters } from '@/lib/feed-data'
import { FeedShell } from '@/components/feed/feed-shell'
import {
  parseSearchQuery,
  extendFeedFilters,
  type ExtractedFilters,
  type FilterChipKey,
} from '@/lib/search'
import {
  getKnownSavers,
  hashProfileSet,
  loadAllProfileFiles,
  mergeProfileConstraints,
} from '@/lib/profile-set'
import { chainRescoreAfter } from '@/lib/rescore-helper'
import { getSaveStateForListings, getTotalSavedCount } from '@/lib/save-state'
import type { RankedListing } from '@/types'

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

// ---------- auto-rescore on stale-hash detection (Fix 3) ----------
//
// When the feed renders against an out-of-date `profile_set_hash` (e.g. after
// a `hashProfileSet` change ships in a deploy, or the user edits a profile),
// queue ONE background rescore via `after()` so the next render lands fresh
// scores. The card UI already renders a stale shimmer for these listings, so
// the user just sees converging scores instead of an empty feed.
//
// Dedup guard: an in-memory Map keyed by the current hash with a 5-minute
// TTL prevents 100 parallel rescores when the feed is hot during a stale
// window. Process-local (resets on cold start) — that's intentional, since a
// cold start = new deploy = fresh hash anyway.

const RESCORE_DEDUP_TTL_MS = 5 * 60 * 1000
const rescoreInFlight = new Map<string, number>()

function shouldQueueRescore(hash: string): boolean {
  if (!hash) return false
  const now = Date.now()
  // Sweep stale entries opportunistically so the map doesn't grow unbounded.
  for (const [k, ts] of rescoreInFlight) {
    if (now - ts > RESCORE_DEDUP_TTL_MS) rescoreInFlight.delete(k)
  }
  const last = rescoreInFlight.get(hash)
  if (last && now - last < RESCORE_DEDUP_TTL_MS) return false
  rescoreInFlight.set(hash, now)
  return true
}

function detectStale(listings: RankedListing[], currentHash: string): boolean {
  if (!currentHash) return false
  for (const l of listings) {
    const h = l.score?.profile_set_hash ?? ''
    if (h && h !== 'mock' && h !== currentHash) return true
  }
  return false
}

function maybeQueueAutoRescore(
  listings: RankedListing[],
  currentHash: string,
): void {
  if (!detectStale(listings, currentHash)) return
  if (!shouldQueueRescore(currentHash)) return
  // Don't await — ship the response now; rescore lands for the next render.
  after(async () => {
    try {
      await chainRescoreAfter(null) // null = rescore the full active set
      // Bust the feed cache so the next render picks up the fresh scores.
      try {
        revalidateTag('feed', 'max')
      } catch {
        /* outside request scope in some edge paths — ignore */
      }
    } catch (err) {
      console.warn('[page] auto-rescore failed', err)
    }
  })
}

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
  // different `profile_set_hash` are mid-rescore. Surfaced via a "scoring..."
  // shimmer on the score badge so the user knows the rank is in flight.
  const currentProfileHash = profiles.length > 0 ? hashProfileSet(profiles) : ''

  // Default saver wires the heart on every card. First slug in the profile
  // set wins. Multi-saver picker is a follow-up.
  const savers = await getKnownSavers().catch(() => [])
  const defaultSaver = savers[0]
  // Total saved-count for the header pill. Cheap aggregate.
  const savedCount = await getTotalSavedCount().catch(() => 0)

  /**
   * Compute the listing IDs the default saver has already saved across the
   * rendered feed so each heart hydrates with the right initial state.
   */
  async function savedIdsFor(listings: RankedListing[]): Promise<string[]> {
    if (!defaultSaver || listings.length === 0) return []
    const map = await getSaveStateForListings(listings.map((l) => l.id)).catch(
      () => ({} as Record<string, string[]>),
    )
    const out: string[] = []
    for (const id of Object.keys(map)) {
      if (map[id]?.includes(defaultSaver)) out.push(id)
    }
    return out
  }

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
    const { listings, neighborhood_counts } = await getRankedFeedWithCounts({
      freshnessDays: 30,
      neighborhoods: effectiveNeighborhoods,
    })
    maybeQueueAutoRescore(listings, currentProfileHash)
    const latestSeen = pickLatestSeen(listings)
    const initialSavedIds = await savedIdsFor(listings)
    return (
      <FeedShell
        initial={listings}
        jointAreas={jointAreas}
        usingDefaultAreas={usingDefaultAreas}
        showWelcome={showWelcome}
        currentProfileHash={currentProfileHash}
        neighborhoodCounts={neighborhood_counts}
        selectedNeighborhoods={explicitNbhds}
        latestSeenAt={latestSeen}
        defaultSaver={defaultSaver}
        initialSavedIds={initialSavedIds}
        savedCount={savedCount}
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
    const { listings, neighborhood_counts } = await getRankedFeedWithCounts({
      freshnessDays: 30,
      keywords: dropped.keywords ?? undefined,
      query: rawQuery,
      // The user-typed query takes priority over the profile area default.
      // Search is an explicit "show me X" gesture, not a passive feed.
      neighborhoods: explicitNbhds.length > 0 ? explicitNbhds : undefined,
    })
    maybeQueueAutoRescore(listings, currentProfileHash)
    const latestSeen = pickLatestSeen(listings)
    const initialSavedIds = await savedIdsFor(listings)
    return (
      <FeedShell
        initial={listings}
        searchQuery={rawQuery}
        searchFilters={dropped}
        jointAreas={jointAreas}
        usingDefaultAreas={false}
        showWelcome={showWelcome}
        currentProfileHash={currentProfileHash}
        neighborhoodCounts={neighborhood_counts}
        selectedNeighborhoods={explicitNbhds}
        latestSeenAt={latestSeen}
        defaultSaver={defaultSaver}
        initialSavedIds={initialSavedIds}
        savedCount={savedCount}
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
  const { listings, neighborhood_counts } = await getRankedFeedWithCounts(filters)
  maybeQueueAutoRescore(listings, currentProfileHash)
  const latestSeen = pickLatestSeen(listings)
  const initialSavedIds = await savedIdsFor(listings)

  return (
    <FeedShell
      initial={listings}
      searchQuery={rawQuery}
      searchFilters={effective}
      jointAreas={jointAreas}
      usingDefaultAreas={false}
      showWelcome={showWelcome}
      currentProfileHash={currentProfileHash}
      neighborhoodCounts={neighborhood_counts}
      selectedNeighborhoods={explicitNbhds}
      latestSeenAt={latestSeen}
      defaultSaver={defaultSaver}
      initialSavedIds={initialSavedIds}
      savedCount={savedCount}
    />
  )
}

/**
 * Pull the most-recent `last_seen_at` (falls back to `posted_at`) from the
 * server-rendered feed so the new-listings poller can ask the API "anything
 * new since I rendered?". Returns null when the feed is empty.
 */
function pickLatestSeen(listings: Array<{ last_seen_at?: Date | null; posted_at?: Date | null }>): string | null {
  let max = 0
  for (const l of listings) {
    const candidates = [l.last_seen_at, l.posted_at]
    for (const c of candidates) {
      if (c instanceof Date && !Number.isNaN(c.getTime())) {
        if (c.getTime() > max) max = c.getTime()
      }
    }
  }
  return max > 0 ? new Date(max).toISOString() : null
}
