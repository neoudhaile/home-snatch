import type { DqMetrics } from '@/lib/data-quality'
import { cn } from '@/lib/utils'

/**
 * 5-bucket score histogram (0-20 / 20-40 / 40-60 / 60-80 / 80-100). SVG, no
 * chart lib, no entry animation.
 */
export function ScoreHistogram({
  health,
}: {
  health: DqMetrics['score_health']
}) {
  const buckets: Array<{ label: keyof DqMetrics['score_health']['score_buckets']; tone: string }> = [
    { label: '0-20', tone: 'fill-destructive/70' },
    { label: '20-40', tone: 'fill-warm-fg/80' },
    { label: '40-60', tone: 'fill-muted-foreground/70' },
    { label: '60-80', tone: 'fill-cool-fg/80' },
    { label: '80-100', tone: 'fill-foreground/85' },
  ]
  const max = Math.max(1, ...buckets.map((b) => health.score_buckets[b.label]))

  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">Score distribution</h3>
        <span className="tabular text-[11px] text-muted-foreground">
          n={health.total_scored.toLocaleString('en-US')} · avg {health.avg_score.toFixed(1)} · median {health.median_score.toFixed(1)}
        </span>
      </div>
      <div className="px-4 py-4">
        <div className="grid grid-cols-5 items-end gap-3">
          {buckets.map((b) => {
            const n = health.score_buckets[b.label]
            const h = (n / max) * 100
            return (
              <div key={b.label} className="flex flex-col items-center gap-2">
                <div className="flex h-32 w-full items-end">
                  <svg viewBox="0 0 10 100" preserveAspectRatio="none" className="h-full w-full">
                    <rect x="0" y="0" width="10" height="100" rx="1" className="fill-muted" />
                    <rect
                      x="0"
                      y={(100 - h).toFixed(2)}
                      width="10"
                      height={h.toFixed(2)}
                      rx="1"
                      className={cn(b.tone)}
                    />
                  </svg>
                </div>
                <div className="tabular text-[12px] text-foreground">
                  {n.toLocaleString('en-US')}
                </div>
                <div className="text-[11px] text-muted-foreground">{b.label}</div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
