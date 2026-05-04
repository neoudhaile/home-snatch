'use client'

import type { RankedListing } from '@/types'
import { SavedCard } from './saved-card'
import { SavedEmpty } from './empty-state'
import { cn } from '@/lib/utils'

type Saver = string

type Props = {
  title: string
  /** sub-label rendered next to the title, e.g. "by joint score" */
  hint?: string
  listings: RankedListing[]
  /** Saved-by tag passed to each card (drives the X behavior). */
  savedBy: Saver | 'both'
  /** All known saver slugs — used by cards when removing a "both"-saved row. */
  allSavers: Saver[]
  /** Display name for the empty-state copy when `emptyKind` is a slug. */
  emptyDisplayName?: string
  /** Empty-state copy variant. */
  emptyKind?: Saver | 'both' | 'self'
  /** Whether this section is the headline / intersection. Visually elevates. */
  headline?: boolean
  /** Compare-selection state, owned by the parent shell. */
  selected: Set<string>
  onToggleSelect: (id: string, next: boolean) => void
}

export function SavedSection({
  title,
  hint,
  listings,
  savedBy,
  allSavers,
  emptyDisplayName,
  emptyKind,
  headline = false,
  selected,
  onToggleSelect,
}: Props) {
  return (
    <section
      className={cn(
        'space-y-3',
        headline && 'rounded-2xl border border-foreground/15 bg-surface-2/40 p-4 sm:p-5',
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2
          className={cn(
            'flex items-baseline gap-2',
            headline
              ? 'serif text-[26px] italic leading-none tracking-tight text-foreground'
              : 'text-[15px] font-semibold tracking-tight text-foreground',
          )}
        >
          {title}
          <span
            className={cn(
              'tabular text-muted-foreground',
              headline ? 'text-[14px] not-italic' : 'text-[12px]',
            )}
          >
            {listings.length}
          </span>
        </h2>
        {hint ? (
          <span className="tabular text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
            {hint}
          </span>
        ) : null}
      </div>

      {listings.length === 0 ? (
        emptyKind ? <SavedEmpty kind={emptyKind} displayName={emptyDisplayName} /> : null
      ) : (
        <div
          className={cn(
            'grid gap-2.5',
            headline ? 'sm:grid-cols-2' : 'sm:grid-cols-2 lg:grid-cols-3',
          )}
        >
          {listings.map((l) => (
            <SavedCard
              key={l.id}
              listing={l}
              savedBy={savedBy}
              allSavers={allSavers}
              selected={selected.has(l.id)}
              onToggleSelect={onToggleSelect}
              variant={headline ? 'highlight' : 'compact'}
            />
          ))}
        </div>
      )}
    </section>
  )
}
