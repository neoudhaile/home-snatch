'use client'

import { useMemo, useState } from 'react'
import { Header, type HeaderState } from '@/components/shell/header'
import { BentoGrid } from './bento-grid'
import { EmptyState } from './empty-state'
import type { RankedListing, Source } from '@/types'

export function FeedShell({ initial }: { initial: RankedListing[] }) {
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

  return (
    <>
      <Header state={state} onChange={setState} showFilters={!isFullyEmpty} />
      <main className="mx-auto w-full max-w-[1480px] flex-1 px-4 py-6 sm:px-6 lg:px-8">
        {isFullyEmpty ? (
          <EmptyState />
        ) : listings.length === 0 ? (
          <NoMatchInWindow onReset={() => setState({ freshness: 30, sources: [] })} />
        ) : (
          <>
            <FeedSummary count={listings.length} freshnessDays={state.freshness} />
            <BentoGrid listings={listings} />
          </>
        )}
      </main>
    </>
  )
}

function NoMatchInWindow({ onReset }: { onReset: () => void }) {
  return (
    <div className="grid place-items-center px-6 py-24 text-center">
      <div className="max-w-md">
        <h2 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
          Nothing in this window.
        </h2>
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
  const window =
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
        <span className="font-medium text-foreground">{count}</span> listings, {window}
      </p>
    </div>
  )
}
