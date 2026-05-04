'use client'

import Link from 'next/link'
import { Bookmark, Plus, SlidersHorizontal } from 'lucide-react'
import { ThemeToggle } from './theme-toggle'
import { FreshnessSelector } from './freshness-selector'
import { SourceFilter } from './source-filter'
import type { Source } from '@/types'

export type HeaderState = {
  freshness: 1 | 7 | 14 | 30
  sources: Source[]
}

export function Header({
  state,
  onChange,
  savedCount = 0,
  showFilters = true,
}: {
  state: HeaderState
  onChange: (next: HeaderState) => void
  savedCount?: number
  showFilters?: boolean
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

        {/* Filters cluster: center on desktop */}
        {showFilters ? (
          <div className="ml-2 hidden items-center gap-2 md:flex">
            <FreshnessSelector
              value={state.freshness}
              onChange={(freshness) => onChange({ ...state, freshness })}
            />
            <SourceFilter
              value={state.sources}
              onChange={(sources) => onChange({ ...state, sources })}
            />
          </div>
        ) : null}

        {/* Right cluster */}
        <div className="ml-auto flex items-center gap-1.5">
          <Link
            href="/add"
            aria-label="Add a listing by URL"
            className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Paste URL</span>
          </Link>
          <Link
            href="/setup"
            aria-label="Open setup"
            className="tabular hidden h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary md:inline-flex"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            <span>Setup</span>
          </Link>
          <Link
            href="/saved"
            aria-label="Saved listings"
            className="tabular relative inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
          >
            <Bookmark className="h-3.5 w-3.5" />
            <span>Saved</span>
            <span className="tabular ml-0.5 text-muted-foreground">{savedCount}</span>
          </Link>
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile filter row */}
      {showFilters ? (
        <div className="flex items-center gap-2 overflow-x-auto px-4 pb-2 sm:px-6 md:hidden">
          <FreshnessSelector
            value={state.freshness}
            onChange={(freshness) => onChange({ ...state, freshness })}
          />
          <SourceFilter
            value={state.sources}
            onChange={(sources) => onChange({ ...state, sources })}
          />
        </div>
      ) : null}
    </header>
  )
}
