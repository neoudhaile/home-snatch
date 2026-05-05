'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { X } from 'lucide-react'
import { Header, type HeaderState } from '@/components/shell/header'
import { BentoGrid } from './bento-grid'
import { EmptyState } from './empty-state'
import { SearchBanner } from './search-banner'
import { NeighborhoodChips } from './neighborhood-chips'
import { NewListingsPoller } from './new-listings-poller'
import type { RankedListing, Source } from '@/types'
import type { ExtractedFilters, FilterChipKey } from '@/lib/search'

export function FeedShell({
  initial,
  searchQuery,
  searchFilters,
  jointAreas = [],
  usingDefaultAreas = false,
  showWelcome = false,
  currentProfileHash = '',
  neighborhoodCounts = {},
  selectedNeighborhoods = [],
  latestSeenAt = null,
}: {
  initial: RankedListing[]
  /** Raw NL query from `?q=` (passed through so the input can re-seed). */
  searchQuery?: string
  /** Server-extracted filters when a search is active. */
  searchFilters?: ExtractedFilters
  /** Joint preferred areas across every profile in src/profiles/. */
  jointAreas?: string[]
  /** True when the feed was auto-filtered to those areas. */
  usingDefaultAreas?: boolean
  /** True when the user just landed from `/setup` (`?welcome=1`). */
  showWelcome?: boolean
  /** Stable hash of the live profile set; used to flag stale-score listings. */
  currentProfileHash?: string
  /** canonical → count, computed off the active+fresh window. */
  neighborhoodCounts?: Record<string, number>
  /** Neighborhoods explicitly chosen via `?neighborhoods=` (display form). */
  selectedNeighborhoods?: string[]
  /** Most-recent `last_seen_at` in the rendered feed; passed to the poller. */
  latestSeenAt?: string | null
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [state, setState] = useState<HeaderState>({
    freshness: 14,
    sources: [],
  })
  const [welcomeOpen, setWelcomeOpen] = useState(showWelcome)
  // Sync to the prop so a fresh `?welcome=1` navigation re-opens the banner
  // even if it was previously dismissed.
  useEffect(() => {
    setWelcomeOpen(showWelcome)
  }, [showWelcome])
  // Banner is always dismissable, plus auto-fades after 10s.
  useEffect(() => {
    if (!welcomeOpen) return
    const t = setTimeout(() => setWelcomeOpen(false), 10_000)
    return () => clearTimeout(t)
  }, [welcomeOpen])

  const listings = useMemo(() => {
    const cutoffHours = state.freshness * 24
    let out = initial.filter(
      (l) => (l.freshness_hours ?? Infinity) <= cutoffHours,
    )
    if (state.sources.length) {
      const allowed = new Set<Source>(state.sources)
      out = out.filter((l) => allowed.has(l.source as Source))
    }
    return out
  }, [initial, state])

  const isFullyEmpty = initial.length === 0
  const isSearchActive = !!searchFilters && !!searchQuery
  const hasJointAreas = jointAreas.length > 0
  // Total active count (sum of all per-neighborhood counts) — fed to the
  // "All NYC" pill so users see "All NYC · 1900" not just an unanchored label.
  const totalActiveCount = useMemo(() => {
    let n = 0
    for (const v of Object.values(neighborhoodCounts)) n += v
    return n
  }, [neighborhoodCounts])

  // Chip-removal: append the chip key to `?drop=...` so the server re-runs
  // with that field stripped.
  const onRemoveChip = useCallback(
    (key: FilterChipKey) => {
      const next = new URLSearchParams(params.toString())
      const existing = (next.get('drop') ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (!existing.includes(key)) existing.push(key)
      next.set('drop', existing.join(','))
      router.push(`/?${next.toString()}`)
    },
    [params, router]
  )

  const onClearSearch = useCallback(() => {
    router.push('/')
  }, [router])

  // "My areas" toggle: flip between the joint-areas default and ?show_all=1.
  const onToggleAreas = useCallback(() => {
    const next = new URLSearchParams(params.toString())
    next.delete('welcome')
    if (usingDefaultAreas) {
      next.set('show_all', '1')
    } else {
      next.delete('show_all')
      next.delete('neighborhoods')
    }
    const qs = next.toString()
    router.push(qs ? `/?${qs}` : '/')
  }, [params, router, usingDefaultAreas])

  return (
    <>
      <Header
        state={state}
        onChange={setState}
        showFilters={!isFullyEmpty || isSearchActive}
        initialQuery={searchQuery}
        areasToggle={
          hasJointAreas && !isSearchActive
            ? {
                active: usingDefaultAreas,
                jointAreas,
                onToggle: onToggleAreas,
              }
            : undefined
        }
      />
      <NewListingsPoller initialLatest={latestSeenAt} />
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {welcomeOpen ? (
          <WelcomeBanner onDismiss={() => setWelcomeOpen(false)} />
        ) : null}
        {/* Inline neighborhood picker — sits above the bento grid so a single
            click rewires the feed without re-running the wizard. We hide it
            during an active search since the search banner owns the filter
            chip surface in that flow. */}
        {!isSearchActive && (hasJointAreas || Object.keys(neighborhoodCounts).length > 0) ? (
          <NeighborhoodChips
            jointAreas={jointAreas}
            selectedAreas={selectedNeighborhoods}
            counts={neighborhoodCounts}
            totalActiveCount={totalActiveCount}
          />
        ) : null}
        {isSearchActive && searchFilters ? (
          <SearchBanner
            filters={searchFilters}
            query={searchQuery}
            onRemoveChip={onRemoveChip}
            onClear={onClearSearch}
            resultCount={listings.length}
          />
        ) : null}
        {isFullyEmpty && usingDefaultAreas && !isSearchActive ? (
          <NoListingsInAreas
            jointAreas={jointAreas}
            onShowAll={onToggleAreas}
          />
        ) : isFullyEmpty && !isSearchActive ? (
          <EmptyState />
        ) : isSearchActive && listings.length === 0 ? (
          <NoSearchMatches onClear={onClearSearch} />
        ) : listings.length === 0 ? (
          <NoMatchInWindow onReset={() => setState({ freshness: 30, sources: [] })} />
        ) : (
          <>
            {!isSearchActive ? (
              <FeedSummary
                count={listings.length}
                freshnessDays={state.freshness}
                usingDefaultAreas={usingDefaultAreas}
                jointAreas={jointAreas}
                onShowAll={onToggleAreas}
              />
            ) : null}
            <BentoGrid listings={listings} currentProfileHash={currentProfileHash} />
          </>
        )}
      </main>
    </>
  )
}

/* ---------- area-aware empty + welcome ---------- */

function WelcomeBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="mb-5 flex items-start gap-3 rounded-2xl border border-border bg-surface-2 px-4 py-3 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-300"
    >
      <span
        aria-hidden
        className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">
          Re-ranking against your profile.
        </p>
        <p className="mt-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Top picks are updating below. New scores land within a minute.
        </p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="grid h-7 w-7 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  )
}

function NoListingsInAreas({
  jointAreas,
  onShowAll,
}: {
  jointAreas: string[]
  onShowAll: () => void
}) {
  const summary = renderAreaSummary(jointAreas, 3)
  return (
    <div className="grid place-items-center px-6 py-24 text-center">
      <div className="max-w-md">
        <h1 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          Nothing in {summary} yet.
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          Broaden the filter or pull fresh listings from the sources you have
          configured.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            onClick={onShowAll}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
          >
            Broaden to all NYC
          </button>
          <a
            href="#scrape"
            onClick={(e) => {
              e.preventDefault()
              const btn = document.querySelector<HTMLButtonElement>(
                'button[aria-label="Scrape new listings now"]',
              )
              btn?.click()
            }}
            className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Run scrape now
          </a>
        </div>
      </div>
    </div>
  )
}

/**
 * "SoHo · NoHo · East Village +4 more" — used in the area summary line under
 * the wordmark and in the no-listings empty state.
 */
function renderAreaSummary(areas: string[], visible: number): string {
  if (areas.length === 0) return 'your areas'
  if (areas.length <= visible) return areas.join(' · ')
  const head = areas.slice(0, visible).join(' · ')
  const more = areas.length - visible
  return `${head} +${more} more`
}

function NoSearchMatches({ onClear }: { onClear: () => void }) {
  return (
    <div className="grid place-items-center px-6 py-20 text-center">
      <div className="max-w-md">
        <h1 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          No matches for that search.
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          Try loosening it. Drop a filter chip above, widen the freshness window, or clear and start over.
        </p>
        <button
          onClick={onClear}
          className="mt-5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Clear search
        </button>
      </div>
    </div>
  )
}

function NoMatchInWindow({ onReset }: { onReset: () => void }) {
  return (
    <div className="grid place-items-center px-6 py-24 text-center">
      <div className="max-w-md">
        <h1 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          Nothing in this window.
        </h1>
        <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
          Widen the freshness window or clear the source filter.
        </p>
        <button
          onClick={onReset}
          className="mt-5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background transition-opacity hover:opacity-90"
        >
          Reset filters
        </button>
      </div>
    </div>
  )
}

function FeedSummary({
  count,
  freshnessDays,
  usingDefaultAreas,
  jointAreas,
  onShowAll,
}: {
  count: number
  freshnessDays: 1 | 7 | 14 | 30
  usingDefaultAreas: boolean
  jointAreas: string[]
  onShowAll: () => void
}) {
  const windowLabel =
    freshnessDays === 1
      ? 'last 24 hours'
      : freshnessDays === 7
        ? 'last 7 days'
        : freshnessDays === 14
          ? 'last 14 days'
          : 'last 30 days'
  return (
    <div className="mb-4 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="serif text-[34px] leading-none tracking-[-0.01em] text-foreground sm:text-[40px]">
          ranked.
        </h1>
        <p className="tabular text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{count}</span> listings, {windowLabel}
        </p>
      </div>
      {usingDefaultAreas && jointAreas.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <span>
            Showing{' '}
            <span className="text-foreground/80">
              {renderAreaSummary(jointAreas, 3)}
            </span>
            .
          </span>
          <button
            type="button"
            onClick={onShowAll}
            className="cursor-pointer text-foreground underline-offset-[3px] transition-colors hover:underline"
          >
            Show all NYC instead
          </button>
        </div>
      ) : !usingDefaultAreas && jointAreas.length > 0 ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <span>Showing all NYC.</span>
          <button
            type="button"
            onClick={onShowAll}
            className="cursor-pointer text-foreground underline-offset-[3px] transition-colors hover:underline"
          >
            ← back to your areas
          </button>
        </div>
      ) : null}
    </div>
  )
}
