'use client'

import Link from 'next/link'
import { Home } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useRailMap } from './rail-context'

const MAX_LABEL_CHARS = 32

/**
 * Inline citation pill for a listing UUID. Renders a small `<a>` with the
 * listing's headline (from the rail map) or a short fallback.
 *
 * Used in two places:
 *   1. Markdown link override when the model emits `[Title](listing:UUID)`
 *   2. Loose UUID-regex fallback inside text nodes for older outputs
 */
export function ListingPill({
  id,
  label,
  className,
}: {
  id: string
  /** Optional explicit label from `[Title](listing:UUID)`. Wins over rail data. */
  label?: string
  className?: string
}) {
  const railMap = useRailMap()
  const railEntry = railMap.get(id)

  const displayLabel = pickLabel(label, railEntry?.headline ?? railEntry?.title)
  const score = railEntry?.score

  return (
    <Link
      href={`/listing/${id}`}
      title={displayLabel ?? id}
      className={cn(
        'group/pill inline-flex max-w-full items-center gap-1 rounded-full',
        'border border-border bg-surface-2 px-2 py-0.5',
        'text-[12px] font-medium leading-5 text-foreground/90',
        'align-baseline whitespace-nowrap no-underline',
        'transition-colors duration-150 hover:bg-secondary hover:text-foreground hover:border-foreground/20',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        className,
      )}
    >
      <Home
        className="h-3 w-3 shrink-0 text-muted-foreground transition-colors group-hover/pill:text-foreground"
        aria-hidden
      />
      <span className="max-w-[22ch] truncate">
        {displayLabel ?? shortId(id)}
      </span>
      {typeof score === 'number' && score > 0 ? (
        <span
          className="tabular -mr-0.5 inline-flex h-4 min-w-[1.25rem] items-center justify-center rounded-full bg-background px-1 text-[10px] font-semibold text-foreground/80 ring-1 ring-inset ring-border"
          aria-label={`Score ${score}`}
        >
          {score}
        </span>
      ) : null}
    </Link>
  )
}

function pickLabel(explicit: string | undefined, fromRail: string | undefined): string | null {
  const raw = (explicit ?? fromRail ?? '').trim()
  if (!raw) return null
  if (raw.length <= MAX_LABEL_CHARS) return raw
  return raw.slice(0, MAX_LABEL_CHARS - 1).trimEnd() + '...'
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}...${id.slice(-4)}` : id
}
