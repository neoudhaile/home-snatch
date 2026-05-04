import { Shield, TriangleAlert } from 'lucide-react'
import { SectionCard } from './contact-card'

export function PublicRecords({
  hpdCount12mo,
  rentStabilized,
  address,
}: {
  hpdCount12mo: number | null | undefined
  rentStabilized: boolean | null | undefined
  address: string | null | undefined
}) {
  return (
    <SectionCard title="Public records" hint={address ?? null}>
      <div className="grid grid-cols-2 gap-3">
        <RecordTile
          icon={<TriangleAlert className="h-3.5 w-3.5" />}
          label="HPD violations, last 12 months"
          value={hpdCount12mo == null ? 'unknown' : String(hpdCount12mo)}
          tone={hpdCount12mo == null ? 'muted' : hpdCount12mo === 0 ? 'good' : hpdCount12mo > 5 ? 'bad' : 'mid'}
        />
        <RecordTile
          icon={<Shield className="h-3.5 w-3.5" />}
          label="Rent stabilization"
          value={rentStabilized == null ? 'unknown' : rentStabilized ? 'stabilized' : 'not stabilized'}
          tone={rentStabilized ? 'good' : 'muted'}
        />
      </div>
      <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        HPD and Rent Stabilization data via NYC Open Data, joined on BBL.
      </p>
    </SectionCard>
  )
}

function RecordTile({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode
  label: string
  value: string
  tone: 'good' | 'mid' | 'bad' | 'muted'
}) {
  const toneClass = {
    good: 'bg-cool text-cool-fg',
    mid: 'bg-warm text-warm-fg',
    bad: 'bg-destructive/15 text-destructive dark:bg-destructive/25',
    muted: 'bg-secondary text-muted-foreground',
  }[tone]

  return (
    <div className="rounded-xl border border-border bg-surface-2 p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.06em] text-muted-foreground">
        <span
          aria-hidden
          className={`grid h-5 w-5 place-items-center rounded-full ${toneClass}`}
        >
          {icon}
        </span>
        {label}
      </div>
      <div className="tabular mt-2 text-[18px] font-semibold text-foreground">
        {value}
      </div>
    </div>
  )
}
