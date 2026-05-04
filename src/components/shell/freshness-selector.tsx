'use client'

import { cn } from '@/lib/utils'

const OPTIONS: Array<{ value: 1 | 7 | 14 | 30; label: string }> = [
  { value: 1, label: '24h' },
  { value: 7, label: '7d' },
  { value: 14, label: '14d' },
  { value: 30, label: '30d' },
]

export function FreshnessSelector({
  value,
  onChange,
}: {
  value: 1 | 7 | 14 | 30
  onChange: (v: 1 | 7 | 14 | 30) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Freshness window"
      className="inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-2 p-0.5"
    >
      {OPTIONS.map((opt) => {
        const active = value === opt.value
        return (
          <button
            key={opt.value}
            role="radio"
            aria-checked={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              'tabular relative h-7 cursor-pointer rounded-full px-3 text-[12px] font-medium transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
              active
                ? 'bg-foreground text-background'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}
