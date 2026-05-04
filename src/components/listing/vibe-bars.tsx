import type { NeighborhoodVibe } from '@/types'
import { SectionCard } from './contact-card'

const ROWS: Array<{
  key: keyof Pick<NeighborhoodVibe, 'walkability' | 'cafes' | 'greenness' | 'nightlife' | 'family_score' | 'noise'>
  label: string
  source: string
  /** Some signals (noise) read better inverted. */
  invert?: boolean
}> = [
  { key: 'walkability', label: 'walkable', source: 'NYC street network + amenity density' },
  { key: 'cafes', label: 'cafes', source: 'Yelp + DOHMH cafe count, normalized' },
  { key: 'greenness', label: 'green', source: 'NYC Parks + tree canopy' },
  { key: 'nightlife', label: 'nightlife', source: 'SLA active liquor licenses' },
  { key: 'family_score', label: 'family', source: 'School proximity + park density' },
  { key: 'noise', label: 'quiet', source: '311 noise complaints (inverted)', invert: true },
]

export function VibeBars({ vibe }: { vibe: NeighborhoodVibe | null | undefined }) {
  if (!vibe) {
    return (
      <SectionCard title="Neighborhood vibe">
        <p className="text-[13px] text-muted-foreground">No neighborhood data yet.</p>
      </SectionCard>
    )
  }
  const rows = ROWS.map((r) => {
    const raw = vibe[r.key]
    if (raw == null) return null
    const v = r.invert ? 1 - raw : raw
    return { ...r, value: Math.max(0, Math.min(1, v)) }
  }).filter(Boolean) as Array<typeof ROWS[number] & { value: number }>

  return (
    <SectionCard
      title="Neighborhood vibe"
      hint={vibe.nta_name}
    >
      <div className="space-y-2">
        {rows.map((r) => (
          <div
            key={r.key}
            title={r.source}
            className="grid grid-cols-[80px_1fr_42px] items-center gap-3"
          >
            <span className="text-[12px] text-foreground/80">{r.label}</span>
            <div
              role="meter"
              aria-label={`${r.label} score`}
              aria-valuenow={Math.round(r.value * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              className="relative h-1.5 overflow-hidden rounded-full bg-secondary"
            >
              <span
                className="absolute inset-y-0 left-0 rounded-full bg-foreground/80"
                style={{ width: `${Math.round(r.value * 100)}%` }}
                aria-hidden
              />
            </div>
            <span className="tabular text-right text-[12px] text-muted-foreground">
              {Math.round(r.value * 100)}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t border-border pt-3 text-[11px] leading-relaxed text-muted-foreground">
        Computed from public NYC datasets. Hover a row to see the source.
      </p>
    </SectionCard>
  )
}
