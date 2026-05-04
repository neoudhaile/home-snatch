'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { ArrowUpRight, Heart, MapPin } from 'lucide-react'
import { toast } from 'sonner'
import { ScoreBadge } from '@/components/score/score-badge'
import { formatBeds, formatPrice } from '@/lib/format'
import { cn } from '@/lib/utils'

type Saver = 'inaan' | 'mekonnen'

export type RailListing = {
  id: string
  title: string
  score: number
  headline: string
  price_monthly: number | null
  beds: string | null
  neighborhood: string | null
  borough: string | null
  photo: string | null
}

/**
 * Right-rail of listings the bot has touched, deduped, ordered by first
 * mention. Items are pushed in by the chat shell from `tool_result` SSE events.
 */
export function ListingsRail({ items }: { items: RailListing[] }) {
  if (items.length === 0) return <RailEmpty />

  return (
    <div className="space-y-2">
      <div className="px-1 pb-1">
        <p className="text-[10.5px] uppercase tracking-[0.08em] text-muted-foreground">
          Mentioned · {items.length}
        </p>
      </div>
      <div className="space-y-2">
        {items.map((l) => (
          <RailCard key={l.id} listing={l} />
        ))}
      </div>
    </div>
  )
}

function RailEmpty() {
  return (
    <div className="grid h-full place-items-center px-4 py-12 text-center">
      <p className="max-w-[14rem] text-[12.5px] leading-relaxed text-muted-foreground">
        Listings mentioned in this chat show up here.
      </p>
    </div>
  )
}

function RailCard({ listing }: { listing: RailListing }) {
  const [saved, setSaved] = useState(false)
  const [pending, start] = useTransition()
  const saver: Saver = 'inaan'

  function toggleSave(e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    if (pending) return
    const next = !saved
    setSaved(next)
    start(async () => {
      try {
        const r = await fetch('/api/save', {
          method: next ? 'POST' : 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ listing_id: listing.id, saved_by: saver }),
        })
        if (!r.ok) throw new Error(`save ${r.status}`)
        toast.success(next ? 'Saved.' : 'Removed.')
      } catch {
        setSaved(!next)
        toast.error('Save failed.')
      }
    })
  }

  return (
    <div className="group/rail flex overflow-hidden rounded-xl border border-border bg-card transition-colors duration-200 hover:border-foreground/15">
      <Link
        href={`/listing/${listing.id}`}
        aria-label={listing.title}
        className="flex min-w-0 flex-1 cursor-pointer items-stretch focus-visible:outline-none"
      >
        <div className="relative aspect-square w-[88px] shrink-0 overflow-hidden bg-secondary">
          {listing.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={listing.photo}
              alt={listing.title}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover transition-transform duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover/rail:scale-[1.04]"
            />
          ) : (
            <div className="absolute inset-0 grid place-items-center text-muted-foreground">
              <MapPin className="h-3.5 w-3.5 opacity-60" aria-hidden />
            </div>
          )}
          <div className="absolute left-1 top-1">
            <ScoreBadge score={listing.score} size="sm" />
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col justify-between gap-1 px-3 py-2.5">
          <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-card-foreground">
            {listing.headline || listing.title}
          </p>
          <div className="tabular flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              {formatPrice(listing.price_monthly)}
            </span>
            <span className="text-muted-foreground/60">/mo</span>
            <span aria-hidden>·</span>
            <span className="font-medium text-foreground/85">
              {formatBeds(listing.beds)}
            </span>
            {listing.neighborhood ? (
              <>
                <span aria-hidden>·</span>
                <span className="truncate">{listing.neighborhood}</span>
              </>
            ) : null}
          </div>
        </div>
      </Link>

      <div className="flex shrink-0 flex-col items-stretch justify-between gap-1 p-1.5">
        <button
          type="button"
          onClick={toggleSave}
          disabled={pending}
          aria-pressed={saved}
          aria-label={saved ? 'Remove from saved' : 'Save'}
          className={cn(
            'grid h-7 w-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors',
            'hover:bg-secondary hover:text-foreground disabled:opacity-50',
            saved && 'text-accent-foreground',
          )}
        >
          <Heart
            className={cn(
              'h-3.5 w-3.5 transition-[fill,stroke] duration-200',
              saved ? 'fill-accent stroke-accent' : 'fill-transparent stroke-current',
            )}
            aria-hidden
          />
        </button>
        <Link
          href={`/listing/${listing.id}`}
          aria-label="View listing"
          className="grid h-7 w-7 cursor-pointer place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </Link>
      </div>
    </div>
  )
}
