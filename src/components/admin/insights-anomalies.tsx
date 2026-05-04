/**
 * Anomalies panel. Server Component calling `detectAnomalies()` directly.
 * Compact table, color-coded by severity. Each row links to the listing's
 * source URL in a new tab so the admin can investigate without leaving.
 */
import { TriangleAlert, Info, ShieldAlert, ArrowUpRight } from 'lucide-react'
import { detectAnomalies, type Anomaly, type AnomalySeverity, type AnomalyType } from '@/lib/insights'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const TYPE_LABEL: Record<AnomalyType, string> = {
  price_outlier: 'price outlier',
  no_contact: 'no contact',
  stale_data: 'stale data',
  suspicious_dupe: 'suspicious dupe',
  missing_address: 'missing address',
}

const SEVERITY_STYLES: Record<AnomalySeverity, { tone: string; icon: React.ComponentType<{ className?: string }> }> = {
  danger: { tone: 'text-destructive', icon: ShieldAlert },
  warn: { tone: 'text-warm-fg', icon: TriangleAlert },
  info: { tone: 'text-muted-foreground', icon: Info },
}

export async function InsightsAnomalies() {
  const rows = await detectAnomalies()
  const counts = countBySeverity(rows)

  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">Anomalies</h3>
        <span className="tabular text-[11px] text-muted-foreground">
          {rows.length === 0
            ? 'all clear'
            : `${counts.danger} danger / ${counts.warn} warn / ${counts.info} info`}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <div className="text-[13px] text-foreground">No anomalies detected.</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            Scraper is healthy.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border">
          <div className="grid grid-cols-[16px_120px_minmax(0,1fr)_24px] items-center gap-3 px-4 py-2 text-[11px] uppercase tracking-wider text-muted-foreground">
            <div></div>
            <div>type</div>
            <div>detail</div>
            <div></div>
          </div>
          {rows.map((a) => (
            <AnomalyRow key={`${a.listing_id}::${a.type}`} anomaly={a} />
          ))}
        </div>
      )}
    </div>
  )
}

function AnomalyRow({ anomaly }: { anomaly: Anomaly }) {
  const style = SEVERITY_STYLES[anomaly.severity]
  const Icon = style.icon
  return (
    <a
      href={anomaly.source_url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'group grid grid-cols-[16px_120px_minmax(0,1fr)_24px] items-center gap-3 px-4 py-2.5 text-[13px] transition-colors hover:bg-muted/40'
      )}
    >
      <Icon className={cn('h-3.5 w-3.5', style.tone)} aria-label={anomaly.severity} />
      <div className="text-[12px] text-muted-foreground">{TYPE_LABEL[anomaly.type]}</div>
      <div className="min-w-0">
        <div className="truncate text-foreground">{anomaly.listing_title}</div>
        <div className="truncate text-[12px] text-muted-foreground">{anomaly.detail}</div>
      </div>
      <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
    </a>
  )
}

function countBySeverity(rows: Anomaly[]): Record<AnomalySeverity, number> {
  const out = { danger: 0, warn: 0, info: 0 }
  for (const r of rows) out[r.severity] += 1
  return out
}

export function InsightsAnomaliesSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <Skeleton className="h-3 w-20" />
        <Skeleton className="h-3 w-32" />
      </div>
      <div className="space-y-2 px-4 py-3">
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </div>
  )
}
