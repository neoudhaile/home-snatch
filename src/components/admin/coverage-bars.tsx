import { TriangleAlert } from 'lucide-react'
import type { DqMetrics } from '@/lib/data-quality'
import { cn } from '@/lib/utils'

/**
 * Horizontal SVG bars for coverage gaps, expressed as % of active listings.
 * Bars over 30% surface a red warning icon.
 */
export function CoverageBars({
  totalActive,
  gaps,
}: {
  totalActive: number
  gaps: DqMetrics['coverage_gaps']
}) {
  const rows = [
    { label: 'no photos', n: gaps.no_photos },
    { label: 'no contact', n: gaps.no_contact },
    { label: 'no address', n: gaps.no_address },
    { label: 'no posted_at', n: gaps.no_posted_at },
  ]
  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">Coverage gaps</h3>
        <span className="text-[11px] text-muted-foreground">
          % of {totalActive.toLocaleString('en-US')} active
        </span>
      </div>
      <div className="space-y-2.5 px-4 py-3">
        {rows.map((r) => (
          <Bar key={r.label} label={r.label} numerator={r.n} denominator={totalActive} />
        ))}
      </div>
    </div>
  )
}

function Bar({
  label,
  numerator,
  denominator,
}: {
  label: string
  numerator: number
  denominator: number
}) {
  const pct = denominator > 0 ? Math.min(100, (numerator / denominator) * 100) : 0
  const high = pct >= 30
  return (
    <div className="grid grid-cols-[140px_minmax(0,1fr)_auto] items-center gap-3">
      <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
        {label}
        {high ? (
          <TriangleAlert
            className="h-3 w-3 text-destructive"
            aria-label="over 30% gap"
          />
        ) : null}
      </div>
      <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-2 w-full">
        <rect x="0" y="0" width="100" height="6" rx="2" className="fill-muted" />
        <rect
          x="0"
          y="0"
          width={pct.toFixed(2)}
          height="6"
          rx="2"
          className={cn(high ? 'fill-destructive' : 'fill-foreground/70')}
        />
      </svg>
      <div className="tabular text-right text-[12px] text-foreground">
        <span>{numerator.toLocaleString('en-US')}</span>
        <span className="text-muted-foreground">/{denominator.toLocaleString('en-US')}</span>
        <span className="ml-2 text-muted-foreground">{pct.toFixed(0)}%</span>
      </div>
    </div>
  )
}

/**
 * Stacked horizontal bar for freshness (fresh / stale / old) over scored
 * window. Shares visual language with `CoverageBars`.
 */
export function FreshnessBar({ freshness }: { freshness: DqMetrics['freshness'] }) {
  const total = freshness.fresh + freshness.stale + freshness.old
  const pf = total > 0 ? (freshness.fresh / total) * 100 : 0
  const ps = total > 0 ? (freshness.stale / total) * 100 : 0
  const po = total > 0 ? (freshness.old / total) * 100 : 0
  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">Freshness</h3>
        <span className="tabular text-[11px] text-muted-foreground">
          {total.toLocaleString('en-US')} with posted_at
        </span>
      </div>
      <div className="space-y-3 px-4 py-3">
        <svg viewBox="0 0 100 6" preserveAspectRatio="none" className="h-2 w-full">
          <rect x="0" y="0" width="100" height="6" rx="2" className="fill-muted" />
          <rect x="0" y="0" width={pf.toFixed(2)} height="6" rx="2" className="fill-cool-fg" />
          <rect
            x={pf.toFixed(2)}
            y="0"
            width={ps.toFixed(2)}
            height="6"
            className="fill-warm-fg"
          />
          <rect
            x={(pf + ps).toFixed(2)}
            y="0"
            width={po.toFixed(2)}
            height="6"
            rx="2"
            className="fill-destructive"
          />
        </svg>
        <div className="grid grid-cols-3 gap-2 text-[12px]">
          <Legend swatch="bg-cool-fg" label="fresh ≤14d" value={freshness.fresh} />
          <Legend swatch="bg-warm-fg" label="stale 14–30d" value={freshness.stale} />
          <Legend swatch="bg-destructive" label="old >30d" value={freshness.old} />
        </div>
      </div>
    </div>
  )
}

function Legend({
  swatch,
  label,
  value,
}: {
  swatch: string
  label: string
  value: number
}) {
  return (
    <div className="flex items-center gap-2">
      <span className={cn('inline-block h-2 w-2 rounded-sm', swatch)} />
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular ml-auto text-foreground">
        {value.toLocaleString('en-US')}
      </span>
    </div>
  )
}
