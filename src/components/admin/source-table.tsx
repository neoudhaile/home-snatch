import { TriangleAlert } from 'lucide-react'
import type { SourceMetric } from '@/lib/data-quality'
import { SOURCES, type Source } from '@/types'
import { formatSource } from '@/lib/format'
import { cn } from '@/lib/utils'

/**
 * Per-source health table: active / inactive / fetched in last 24h, 7d.
 * Sources with zero `last_24h` get a soft warning so it's obvious the scrape
 * for that source is silently broken.
 */
export function SourceTable({
  bySource,
}: {
  bySource: Record<Source, SourceMetric>
}) {
  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">By source</h3>
        <span className="text-[11px] text-muted-foreground">
          last 24h / last 7d / active / inactive
        </span>
      </div>
      <div className="divide-y divide-border">
        <div className="grid grid-cols-[1fr_repeat(4,minmax(0,72px))] gap-2 px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
          <div>source</div>
          <div className="text-right">active</div>
          <div className="text-right">inactive</div>
          <div className="text-right">24h</div>
          <div className="text-right">7d</div>
        </div>
        {SOURCES.map((src) => {
          const m = bySource[src]
          const dead24 = m.active > 0 && m.last_24h === 0
          return (
            <div
              key={src}
              className="grid grid-cols-[1fr_repeat(4,minmax(0,72px))] gap-2 px-4 py-2 text-[13px]"
            >
              <div className="flex items-center gap-1.5">
                <span className="text-foreground">{formatSource(src)}</span>
                {dead24 ? (
                  <span
                    title="No fetches in the last 24h"
                    className="inline-flex items-center text-warm-fg"
                  >
                    <TriangleAlert className="h-3 w-3" />
                  </span>
                ) : null}
              </div>
              <Cell value={m.active} />
              <Cell value={m.inactive} muted />
              <Cell value={m.last_24h} dim={dead24} />
              <Cell value={m.last_7d} />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Cell({
  value,
  muted,
  dim,
}: {
  value: number
  muted?: boolean
  dim?: boolean
}) {
  return (
    <div
      className={cn(
        'tabular text-right',
        muted && 'text-muted-foreground',
        dim && 'text-warm-fg'
      )}
    >
      {value.toLocaleString('en-US')}
    </div>
  )
}
