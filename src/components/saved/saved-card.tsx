'use client'

import Link from 'next/link'
import { useTransition, useState } from 'react'
import { X, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import type { RankedListing } from '@/types'
import { ScoreBadge } from '@/components/score/score-badge'
import {
  formatBeds,
  formatFreshness,
  formatPrice,
  formatSource,
} from '@/lib/format'
import { cn } from '@/lib/utils'

type Saver = string
type Variant = 'compact' | 'highlight'

type Props = {
  listing: RankedListing
  /** Which saver owns this card row (used by the X to know what to delete).
   *  For "Both" we fire one delete per known saver (passed via `allSavers`). */
  savedBy: Saver | 'both'
  /** All known saver slugs — used when `savedBy === 'both'` to fan out deletes. */
  allSavers: Saver[]
  /** Add/remove this listing from the compare selection. */
  selected: boolean
  onToggleSelect: (id: string, next: boolean) => void
  variant?: Variant
}

/**
 * Compact saved-card. Smaller than feed-bento. Variant `highlight` is used in
 * the "Both" intersection group to make those listings visually distinct
 * without resorting to a side-stripe (banned).
 */
export function SavedCard({ listing, savedBy, allSavers, selected, onToggleSelect, variant = 'compact' }: Props) {
  const [removing, startRemove] = useTransition()
  const [hidden, setHidden] = useState(false)
  const photo = listing.photos?.[0]
  const score = listing.score?.score ?? 0
  const isStale = (listing.freshness_hours ?? 0) > 7 * 24

  /**
   * Re-POST a save for every saver we just removed. Used by the Undo action
   * on the success toast so a misclick on the X is a one-tap fix.
   */
  function restore(targets: Saver[]) {
    setHidden(false)
    void (async () => {
      try {
        for (const s of targets) {
          await fetch('/api/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ listing_id: listing.id, saved_by: s }),
          })
        }
        toast.success('Restored.')
      } catch {
        toast.error('Could not restore.')
      }
    })()
  }

  function remove(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (removing) return
    setHidden(true)
    startRemove(async () => {
      const targets: Saver[] = savedBy === 'both' ? allSavers : [savedBy]
      try {
        for (const s of targets) {
          const res = await fetch('/api/save', {
            method: 'DELETE',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ listing_id: listing.id, saved_by: s }),
          })
          if (!res.ok) throw new Error(`unsave failed: ${res.status}`)
        }
        toast.success('Removed.', {
          action: {
            label: 'Undo',
            onClick: () => restore(targets),
          },
        })
      } catch (err) {
        setHidden(false)
        toast.error(err instanceof Error ? err.message : 'Remove failed.')
      }
    })
  }

  function toggleSelect(e: React.MouseEvent | React.ChangeEvent) {
    e.stopPropagation()
    onToggleSelect(listing.id, !selected)
  }

  if (hidden) return null

  return (
    <div
      className={cn(
        'group/save-card relative flex overflow-hidden rounded-xl bg-card transition-[border-color,box-shadow] duration-200',
        variant === 'highlight'
          ? 'border border-foreground/20 shadow-[0_2px_18px_-12px_oklch(0.15_0.014_220/0.4)]'
          : 'border border-border',
        'hover:border-foreground/15',
      )}
    >
      <Link
        href={`/listing/${listing.id}`}
        aria-label={listing.title}
        className="flex min-w-0 flex-1 cursor-pointer items-stretch focus-visible:outline-none"
      >
        <div className="relative aspect-square w-[112px] shrink-0 overflow-hidden bg-secondary sm:w-[128px]">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo}
              alt={listing.title}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/save-card:scale-[1.04]"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-muted-foreground">
              <MapPin className="h-4 w-4 opacity-60" aria-hidden />
            </div>
          )}
          <div className="absolute left-1.5 top-1.5">
            <ScoreBadge score={score} size="sm" />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 p-3 sm:p-3.5">
          <div className="min-w-0 space-y-1">
            <p className="line-clamp-2 text-[13.5px] font-medium leading-snug text-card-foreground">
              {listing.score?.headline}
            </p>
            <div className="tabular flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground">
              <span className="font-medium text-foreground">
                {formatPrice(listing.price_monthly)}
              </span>
              <span className="text-muted-foreground/60">/mo</span>
              <span aria-hidden>·</span>
              <span className="font-medium text-foreground/85">{formatBeds(listing.beds)}</span>
              <span aria-hidden>·</span>
              <span className="truncate">{listing.neighborhood}</span>
            </div>
          </div>
          <div className="tabular flex items-center gap-1.5 text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
            <span>{formatSource(listing.source)}</span>
            <span aria-hidden>·</span>
            <span className={cn(isStale && 'text-destructive')}>
              {formatFreshness(listing.freshness_hours)}
            </span>
          </div>
        </div>
      </Link>

      {/* right rail: select + remove */}
      <div className="flex shrink-0 flex-col items-stretch justify-between gap-1 p-2">
        <button
          type="button"
          onClick={remove}
          disabled={removing}
          aria-label="Remove from saved"
          className="grid h-7 w-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground disabled:opacity-50"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
        <label
          className={cn(
            'tabular flex h-7 cursor-pointer items-center justify-center gap-1 rounded-full border px-2 text-[10.5px] font-medium transition-colors',
            selected
              ? 'border-foreground bg-foreground text-background'
              : 'border-border bg-surface-2 text-muted-foreground hover:bg-secondary',
          )}
        >
          <input
            type="checkbox"
            checked={selected}
            onChange={toggleSelect}
            className="sr-only"
            aria-label="Add to compare"
          />
          {selected ? 'In compare' : 'Compare'}
        </label>
      </div>
    </div>
  )
}
