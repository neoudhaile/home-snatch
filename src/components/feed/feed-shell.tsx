'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Header, type HeaderState } from '@/components/shell/header'
import { BentoGrid } from './bento-grid'
import { EmptyState } from './empty-state'
import { SearchBanner } from './search-banner'
import type { RankedListing, Source } from '@/types'
import type { ExtractedFilters, FilterChipKey } from '@/lib/search'

export function FeedShell({
  initial,
  searchQuery,
  searchFilters,
}: {
  initial: RankedListing[]
  /** Raw NL query from `?q=` (passed through so the input can re-seed). */
  searchQuery?: string
  /** Server-extracted filters when a search is active. */
  searchFilters?: ExtractedFilters
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [state, setState] = useState<HeaderState>({
    freshness: 14,
    sources: [],
  })

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

  return (
    <>
      <Header
        state={state}
        onChange={setState}
        showFilters={!isFullyEmpty || isSearchActive}
        initialQuery={searchQuery}
      />
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {isSearchActive && searchFilters ? (
          <SearchBanner
            filters={searchFilters}
            query={searchQuery}
            onRemoveChip={onRemoveChip}
            onClear={onClearSearch}
            resultCount={listings.length}
          />
        ) : null}
        {isFullyEmpty && !isSearchActive ? (
          <EmptyState />
        ) : isSearchActive && listings.length === 0 ? (
          <NoSearchMatches onClear={onClearSearch} />
        ) : listings.length === 0 ? (
          <NoMatchInWindow onReset={() => setState({ freshness: 30, sources: [] })} />
        ) : (
          <>
            {!isSearchActive ? (
              <FeedSummary count={listings.length} freshnessDays={state.freshness} />
            ) : null}
            <BentoGrid listings={listings} />
          </>
        )}
      </main>
    </>
  )
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
}: {
  count: number
  freshnessDays: 1 | 7 | 14 | 30
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
    <div className="mb-4 flex items-baseline justify-between gap-3">
      <h1 className="serif text-[34px] leading-none tracking-[-0.01em] text-foreground sm:text-[40px]">
        ranked.
      </h1>
      <p className="tabular text-[12px] text-muted-foreground">
        <span className="font-medium text-foreground">{count}</span> listings, {windowLabel}
      </p>
    </div>
  )
}
