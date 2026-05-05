'use client'

import Link from 'next/link'
import { Bookmark, MessageCircle, Plus, SlidersHorizontal } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { FreshnessSelector } from './freshness-selector'
import { SourceFilter } from './source-filter'
import { SearchInput } from './search-input'
import { ScrapeButton } from './scrape-button'
import { cn } from '@/lib/utils'
import type { Source } from '@/types'

export type HeaderState = {
  freshness: 1 | 7 | 14 | 30
  sources: Source[]
}

/**
 * "My areas" / "All NYC" toggle config. Only rendered when the user actually
 * has joint preferred_areas configured — the toggle is a no-op otherwise.
 */
export type AreasToggle = {
  /** True = currently filtered to joint preferred_areas. False = showing all NYC. */
  active: boolean
  /** The joint area list (used for tooltip + summary). */
  jointAreas: string[]
  onToggle: () => void
}

export function Header({
  state,
  onChange,
  savedCount = 0,
  showFilters = true,
  showSearch = true,
  showScrape = true,
  initialQuery,
  areasToggle,
}: {
  state: HeaderState
  onChange: (next: HeaderState) => void
  savedCount?: number
  showFilters?: boolean
  showSearch?: boolean
  /**
   * Show the "Scrape now" / Refresh button next to the freshness selector.
   * Default true; pass false on routes (/add, /setup) where a manual scrape
   * is irrelevant or noisy.
   */
  showScrape?: boolean
  initialQuery?: string
  /** Optional "My areas" toggle. Rendered between freshness + source. */
  areasToggle?: AreasToggle
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/85 backdrop-blur-md supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto flex h-14 max-w-[1480px] items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Wordmark */}
        <Link
          href="/"
          aria-label="homeSnatch home"
          className="group inline-flex shrink-0 items-baseline gap-0.5 cursor-pointer focus-visible:outline-none"
        >
          <span className="serif text-[24px] leading-none italic tracking-[-0.02em] text-foreground">
            home
          </span>
          <span className="serif text-[24px] leading-none tracking-[-0.02em] text-foreground">
            Snatch
          </span>
          <span
            aria-hidden
            className="ml-1 inline-block h-1.5 w-1.5 translate-y-[-2px] rounded-full bg-accent transition-transform duration-300 ease-out group-hover:scale-125"
          />
        </Link>

        {/* Center: search (prominent, desktop only — mobile gets its own row below) */}
        {showSearch ? (
          <div className="hidden flex-1 justify-center px-4 md:flex">
            <div className="w-full max-w-[520px]">
              <SearchInput initialQuery={initialQuery} />
            </div>
          </div>
        ) : (
          <div className="hidden flex-1 md:block" />
        )}

        {/* Filters cluster: desktop, sits to the right of search */}
        {showFilters ? (
          <div className="hidden items-center gap-2 md:flex">
            <FreshnessSelector
              value={state.freshness}
              onChange={(freshness) => onChange({ ...state, freshness })}
            />
            {areasToggle ? <AreasPill toggle={areasToggle} /> : null}
            <SourceFilter
              value={state.sources}
              onChange={(sources) => onChange({ ...state, sources })}
            />
            {showScrape ? <ScrapeButton /> : null}
          </div>
        ) : null}

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-1.5 md:ml-0">
          <Link
            href="/add"
            aria-label="Add a listing by URL"
            className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Paste URL</span>
          </Link>
          <Link
            href="/setup"
            aria-label="Open setup"
            className="tabular hidden h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary md:inline-flex"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            <span>Setup</span>
          </Link>
          <Link
            href="/chat"
            aria-label="Chat assistant"
            className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <MessageCircle className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden sm:inline">Chat</span>
          </Link>
          <Link
            href="/saved"
            aria-label="Saved listings"
            className="tabular relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Bookmark className="h-3.5 w-3.5" aria-hidden />
            <span>Saved</span>
            <span className="tabular ml-0.5 text-muted-foreground">{savedCount}</span>
          </Link>
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile: full-width search below the wordmark, then filter row */}
      {showSearch ? (
        <div className="px-4 pb-2 sm:px-6 md:hidden">
          <SearchInput initialQuery={initialQuery} />
        </div>
      ) : null}
      {showFilters ? (
        <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 sm:px-6 md:hidden">
          <FreshnessSelector
            value={state.freshness}
            onChange={(freshness) => onChange({ ...state, freshness })}
          />
          {areasToggle ? <AreasPill toggle={areasToggle} /> : null}
          <SourceFilter
            value={state.sources}
            onChange={(sources) => onChange({ ...state, sources })}
          />
          {showScrape ? <ScrapeButton /> : null}
        </div>
      ) : null}
    </header>
  )
}

/**
 * "My areas" ↔ "All NYC" toggle. Compact two-segment pill that mirrors the
 * freshness selector visual so it feels native to the filter cluster.
 */
function AreasPill({ toggle }: { toggle: AreasToggle }) {
  const tip =
    toggle.jointAreas.length === 0
      ? undefined
      : toggle.jointAreas.join(', ')
  return (
    <div
      role="radiogroup"
      aria-label="Area filter"
      title={tip}
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5"
    >
      <button
        type="button"
        role="radio"
        aria-checked={toggle.active}
        onClick={() => {
          if (!toggle.active) toggle.onToggle()
        }}
        className={cn(
          'tabular relative h-7 cursor-pointer rounded-full px-3 text-[12px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          toggle.active
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        My areas
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={!toggle.active}
        onClick={() => {
          if (toggle.active) toggle.onToggle()
        }}
        className={cn(
          'tabular relative h-7 cursor-pointer rounded-full px-3 text-[12px] font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
          !toggle.active
            ? 'bg-foreground text-background'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        All NYC
      </button>
    </div>
  )
}
