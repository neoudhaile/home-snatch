'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type RowEmphasis = 'normal' | 'warn' | 'danger'

export type ComparisonRowProps = {
  label: string
  /** Optional sub-label rendered under the main label, smaller. */
  hint?: string
  /** One ReactNode per column. Length must match column count. */
  values: ReactNode[]
  /** True when at least one cell differs from the others. */
  differ?: boolean
  emphasis?: RowEmphasis
  /** When highlight-differences is on, equal-across rows are dimmed. */
  dimmed?: boolean
  /** Mute the visual weight of this row (used for tertiary fields). */
  muted?: boolean
  /** Pin a small visual marker (e.g. star) in the label cell. */
  pinned?: boolean
}

/**
 * One row of the compare table. Layout:
 *   - desktop: sticky-left label cell (~140px) + N value cells, equal-width
 *   - mobile: stack. Each value above its column heading is provided by the
 *     parent table; this row just lays out [label, value, value, ...]
 *     vertically below mobile breakpoint.
 *
 * NOT styled like a card. Flat row, separator below.
 */
export function ComparisonRow({
  label,
  hint,
  values,
  differ = false,
  emphasis = 'normal',
  dimmed = false,
  muted = false,
  pinned = false,
}: ComparisonRowProps) {
  return (
    <div
      role="row"
      data-differ={differ ? 'true' : 'false'}
      className={cn(
        // Mobile: each row is a stack (label, then values stacked by parent header)
        // Desktop: a CSS grid set by the parent table.
        'group/row contents transition-opacity duration-200',
        dimmed && 'opacity-40',
      )}
    >
      <div
        role="rowheader"
        className={cn(
          'sticky left-0 z-[2] flex items-start gap-2 border-b border-border bg-background px-3 py-3 sm:px-4',
          'before:absolute before:inset-y-0 before:right-0 before:w-px before:bg-border',
          differ && !dimmed && 'bg-cool/40',
          emphasis === 'warn' && 'text-warm-fg',
          emphasis === 'danger' && 'text-destructive',
          muted && 'text-muted-foreground',
        )}
      >
        {pinned ? (
          <span aria-hidden className="mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        ) : null}
        <div className="min-w-0 flex-1">
          <span
            className={cn(
              'block text-[12px] font-medium tracking-tight',
              muted ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {label}
          </span>
          {hint ? (
            <span className="tabular mt-0.5 block text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
              {hint}
            </span>
          ) : null}
        </div>
      </div>
      {values.map((v, i) => (
        <div
          key={i}
          role="cell"
          className={cn(
            'border-b border-border px-3 py-3 sm:px-4',
            differ && !dimmed && 'bg-cool/40',
            emphasis === 'warn' && 'text-warm-fg',
            emphasis === 'danger' && 'text-destructive',
            muted && 'text-muted-foreground',
          )}
        >
          <div className="text-[13px] leading-snug text-foreground">{v}</div>
        </div>
      ))}
    </div>
  )
}
