'use client'

import Link from 'next/link'
import { useState, useMemo } from 'react'
import { GitCompareArrows } from 'lucide-react'
import type { RankedListing } from '@/types'
import { cn } from '@/lib/utils'
import { SavedSection } from './saved-section'

type Props = {
  /** Listings ALL configured savers have saved (the intersection / headline). */
  both: RankedListing[]
  /**
   * Per-saver saved lists. Keys are profile slugs from src/profiles/.
   * Order is the order sections render.
   */
  bySaver: Array<{ slug: string; name: string; listings: RankedListing[] }>
}

/**
 * Client shell that owns the multi-select state for the compare CTA. Sections
 * are passed pre-fetched listings; the only state that matters here is the
 * selection.
 *
 * Selection rules:
 *   - Cap at 4 (the compare view defaults to 4 columns; 5+ scrolls).
 *   - The "Both" intersection is pre-selected for convenience: if the user
 *     came here to decide and they have overlap, that's what they should
 *     compare first. They can deselect.
 */
export function SavedShell({ both, bySaver }: Props) {
  const totalSaved = both.length + bySaver.reduce((acc, s) => acc + s.listings.length, 0)
  const everySaved = useMemo(
    () => [...both, ...bySaver.flatMap((s) => s.listings)],
    [both, bySaver],
  )
  const [selected, setSelected] = useState<Set<string>>(() => {
    const initial = new Set<string>()
    for (const l of both.slice(0, 4)) initial.add(l.id)
    return initial
  })

  function toggleSelect(id: string, next: boolean) {
    setSelected((cur) => {
      const out = new Set(cur)
      if (next) {
        if (out.size >= 4) return out
        out.add(id)
      } else {
        out.delete(id)
      }
      return out
    })
  }

  const selectedCount = selected.size
  const canCompare = selectedCount >= 2

  // Order the selection by saved order across the groups so the
  // ?ids= param matches the visual order on the page.
  const orderedSelected = useMemo(() => {
    const order = new Map<string, number>()
    everySaved.forEach((l, i) => order.set(l.id, i))
    return [...selected].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
  }, [selected, everySaved])

  const compareHref = canCompare
    ? `/compare?ids=${orderedSelected.join(',')}`
    : '#'

  const allSlugs = bySaver.map((s) => s.slug)

  // "Both" only makes sense as a label when there are exactly 2 savers.
  // For 1, the intersection is irrelevant (it's just that person's list).
  // For 3+, "All" is the honest label.
  const intersectionTitle = bySaver.length <= 1 ? 'All' : bySaver.length === 2 ? 'Both' : 'All'

  return (
    <div className="space-y-6">
      <SavedHeader
        totalSaved={totalSaved}
        selectedCount={selectedCount}
        canCompare={canCompare}
        compareHref={compareHref}
      />

      {bySaver.length >= 2 ? (
        <SavedSection
          title={intersectionTitle}
          hint="by joint score"
          headline
          listings={both}
          savedBy="both"
          allSavers={allSlugs}
          emptyKind="both"
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      ) : null}

      {bySaver.map((s) => (
        <SavedSection
          key={s.slug}
          title={s.name}
          hint="most recent first"
          listings={s.listings}
          savedBy={s.slug}
          allSavers={allSlugs}
          emptyKind={s.slug}
          emptyDisplayName={s.name}
          selected={selected}
          onToggleSelect={toggleSelect}
        />
      ))}
    </div>
  )
}

function SavedHeader({
  totalSaved,
  selectedCount,
  canCompare,
  compareHref,
}: {
  totalSaved: number
  selectedCount: number
  canCompare: boolean
  compareHref: string
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="serif text-[34px] leading-none tracking-[-0.01em] text-foreground sm:text-[40px]">
          saved.
        </h1>
        <p className="tabular mt-1 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground">{totalSaved}</span> across all lists.
          {selectedCount > 0 ? (
            <>
              {' '}
              <span aria-hidden>·</span>{' '}
              <span className="font-medium text-foreground">{selectedCount}</span> picked for compare
              <span className="text-muted-foreground/70"> (max 4)</span>
            </>
          ) : (
            <>
              {' '}
              <span aria-hidden>·</span>{' '}
              Pick at least 2 to compare.
            </>
          )}
        </p>
      </div>
      <Link
        href={compareHref}
        aria-disabled={!canCompare}
        tabIndex={canCompare ? 0 : -1}
        onClick={(e) => {
          if (!canCompare) e.preventDefault()
        }}
        className={cn(
          'tabular inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[13px] font-medium transition-[opacity,background-color]',
          canCompare
            ? 'cursor-pointer bg-foreground text-background hover:opacity-90'
            : 'pointer-events-none cursor-not-allowed border border-border bg-surface-2 text-muted-foreground opacity-70',
        )}
      >
        <GitCompareArrows className="h-3.5 w-3.5" aria-hidden />
        {canCompare
          ? `Compare ${selectedCount}`
          : selectedCount === 1
            ? 'Compare (need 1 more)'
            : 'Compare'}
      </Link>
    </div>
  )
}
