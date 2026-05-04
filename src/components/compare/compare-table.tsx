'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ExternalLink, MapPin, ChevronDown, ChevronUp } from 'lucide-react'
import type { RankedListing } from '@/types'
import {
  formatBeds,
  formatBaths,
  formatBrokerFee,
  formatDistance,
  formatFreshness,
  formatPrice,
  formatSource,
  formatSqft,
} from '@/lib/format'
import { ScoreBadge } from '@/components/score/score-badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { ComparisonRow } from './comparison-row'
import { CompareHeader } from './header'

type Saver = string

type Props = {
  listings: RankedListing[]
  /** Per-listing list of saver chips (from /compare's data fetch). */
  saversByListing: Record<string, Saver[]>
  /** Profiles' commute targets (used for the per-target rows). */
  commuteTargets: { saver: Saver; label: string }[]
  /** slug -> display name, sourced from src/profiles/ in the Server Component. */
  profileNames: Record<string, string>
}

/**
 * Numeric tolerance for "are these vibes equal": anything within 0.05 (5
 * percentage points on a 0..1 score) is considered the same. Anything coarser
 * would mark cells as "different" when the underlying variance is noise.
 */
const VIBE_EPS = 0.05

/**
 * The compare table. Sticky-left label column + N value columns (max ~4
 * visible before horizontal scroll). Mobile collapses to a vertical stack
 * driven by `<MobileColumns>`.
 *
 * Highlight-differences:
 *   - per-row equality is computed against the row's `equalityKey` array
 *     (a normalized representation of each cell's value). If all entries
 *     are equal, the row is "equal"; when highlight is on, it's dimmed.
 *   - rows that differ get a subtle accent.
 *   - vibe row uses VIBE_EPS tolerance (numeric).
 *   - text rows compare normalized lowercase strings.
 *   - missing-vs-present is treated as a difference.
 */
export function CompareTable({ listings, saversByListing, commuteTargets, profileNames }: Props) {
  const [highlight, setHighlight] = useState(true)

  const columns = listings.length
  const gridCols = useMemo(() => {
    // Sticky label cell ~140px, then min-200px per listing column. We DO NOT
    // try to fit 5+ columns on screen; past 4, horizontal scroll is the
    // honest answer. Forcing 5 columns at ~150px each sacrifices density per
    // column and the photo row becomes useless.
    return `minmax(140px, 200px) repeat(${columns}, minmax(220px, 1fr))`
  }, [columns])

  const rows = useMemo(
    () => buildRows(listings, saversByListing, commuteTargets, profileNames),
    [listings, saversByListing, commuteTargets, profileNames],
  )

  return (
    <TooltipProvider>
      <div className="space-y-5">
        <CompareHeader
          count={listings.length}
          highlight={highlight}
          onHighlightChange={setHighlight}
        />

        {/* Mobile: vertical stack per listing. Hidden on >=md. */}
        <MobileColumns
          listings={listings}
          rows={rows}
          highlight={highlight}
          saversByListing={saversByListing}
          profileNames={profileNames}
        />

        {/* Desktop: grid table. */}
        <div className="relative hidden overflow-x-auto md:block">
          <div
            role="table"
            className="grid min-w-full"
            style={{ gridTemplateColumns: gridCols }}
          >
            {/* Top header row: listing column heads (sticky to grid). */}
            <div role="rowheader" className="sticky left-0 z-[2] border-b border-border bg-background px-3 py-3 sm:px-4">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                Field
              </span>
            </div>
            {listings.map((l) => (
              <ColumnHead key={l.id} listing={l} />
            ))}

            {/* Data rows */}
            {rows.map((r) => (
              <ComparisonRow
                key={r.key}
                label={r.label}
                hint={r.hint}
                values={r.values}
                differ={r.differ}
                emphasis={r.emphasis}
                dimmed={highlight && !r.differ && !r.alwaysShow}
                muted={r.muted}
                pinned={r.pinned}
              />
            ))}
          </div>
        </div>

        {listings.length === 0 ? (
          <div className="grid place-items-center px-6 py-24 text-center">
            <div className="max-w-md">
              <h2 className="serif text-[28px] italic leading-tight tracking-tight text-foreground">
                Nothing to compare.
              </h2>
              <p className="mt-2 text-[14px] leading-relaxed text-muted-foreground">
                Pick at least two from your saved list.
              </p>
              <Link
                href="/saved"
                className="mt-5 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[13px] font-medium text-background"
              >
                Open saved
              </Link>
            </div>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  )
}

/* -------------------- column head -------------------- */

function ColumnHead({ listing }: { listing: RankedListing }) {
  const photo = listing.photos?.[0]
  return (
    <div role="columnheader" className="border-b border-border bg-background px-3 py-3 sm:px-4">
      <Link
        href={`/listing/${listing.id}`}
        className="group/colhead flex items-center gap-2.5 text-left focus-visible:outline-none"
      >
        <span className="relative grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-md bg-secondary">
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={photo}
              alt={listing.title}
              loading="lazy"
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <MapPin className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          )}
        </span>
        <div className="min-w-0">
          <p className="line-clamp-1 text-[12.5px] font-semibold leading-snug text-foreground group-hover/colhead:underline">
            {listing.neighborhood ?? 'Listing'}
          </p>
          <p className="tabular text-[11px] text-muted-foreground">
            {formatPrice(listing.price_monthly)} <span className="text-muted-foreground/60">/mo</span> · {formatBeds(listing.beds)}
          </p>
        </div>
      </Link>
    </div>
  )
}

/* -------------------- mobile columns -------------------- */

function MobileColumns({
  listings,
  rows,
  highlight,
  saversByListing,
  profileNames,
}: {
  listings: RankedListing[]
  rows: BuiltRow[]
  highlight: boolean
  saversByListing: Record<string, Saver[]>
  profileNames: Record<string, string>
}) {
  return (
    <div className="md:hidden">
      <div className="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-3">
        {listings.map((l, colIdx) => (
          <article
            key={l.id}
            className="snap-start shrink-0 basis-[88%] rounded-2xl border border-border bg-card"
          >
            <div className="px-4 pt-4">
              <p className="serif text-[20px] italic leading-tight tracking-tight text-foreground">
                {l.neighborhood ?? 'Listing'}
              </p>
              <p className="tabular mt-0.5 text-[12px] text-muted-foreground">
                {formatPrice(l.price_monthly)} <span className="text-muted-foreground/60">/mo</span> · {formatBeds(l.beds)} · {l.borough}
              </p>
            </div>
            <div className="mt-3 divide-y divide-border border-t border-border">
              {rows.map((r) => {
                const dimmed = highlight && !r.differ && !r.alwaysShow
                return (
                  <div
                    key={r.key}
                    className={cn(
                      'flex items-start justify-between gap-3 px-4 py-2.5 transition-opacity',
                      dimmed && 'opacity-40',
                      r.differ && !dimmed && 'bg-cool/30',
                    )}
                  >
                    <div className="min-w-0">
                      <span
                        className={cn(
                          'text-[11.5px] font-medium tracking-tight',
                          r.muted ? 'text-muted-foreground' : 'text-foreground',
                        )}
                      >
                        {r.label}
                      </span>
                      {r.hint ? (
                        <span className="tabular ml-1 text-[10px] uppercase tracking-[0.06em] text-muted-foreground">
                          {r.hint}
                        </span>
                      ) : null}
                    </div>
                    <div
                      className={cn(
                        'min-w-0 max-w-[60%] text-right text-[13px] leading-snug',
                        r.emphasis === 'danger' && 'text-destructive',
                        r.emphasis === 'warn' && 'text-warm-fg',
                      )}
                    >
                      {r.values[colIdx]}
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="px-4 pb-4 pt-2">
              <SaversChips savers={saversByListing[l.id] ?? []} profileNames={profileNames} />
            </div>
          </article>
        ))}
      </div>
    </div>
  )
}

/* -------------------- saver chips -------------------- */

function SaversChips({
  savers,
  profileNames,
}: {
  savers: Saver[]
  profileNames: Record<string, string>
}) {
  if (savers.length === 0) {
    return <span className="text-[12px] text-muted-foreground">Not saved.</span>
  }
  return (
    <div className="flex flex-wrap gap-1">
      {savers.map((s) => (
        <span
          key={s}
          className="tabular inline-flex items-center rounded-full bg-warm px-2 py-[3px] text-[11px] font-medium text-warm-fg"
        >
          {profileNames[s] ?? s}
        </span>
      ))}
    </div>
  )
}

/* -------------------- row builder -------------------- */

type BuiltRow = {
  key: string
  label: string
  hint?: string
  values: React.ReactNode[]
  /** Equality keys per column. Same length as values. */
  equality: (string | number | null)[]
  /** Numeric tolerance applied to equality keys (0 = exact). */
  tol?: number
  differ: boolean
  emphasis?: 'normal' | 'warn' | 'danger'
  muted?: boolean
  pinned?: boolean
  /**
   * If true, this row is shown even when "highlight differences" dims
   * equal-value rows (used for the photo row, score, etc., too important to
   * dim regardless).
   */
  alwaysShow?: boolean
}

function rowsEqual(values: (string | number | null)[], tol = 0): boolean {
  if (values.length <= 1) return true
  const first = values[0]
  for (let i = 1; i < values.length; i++) {
    const v = values[i]
    if (first == null || v == null) {
      if (first !== v) return false
      continue
    }
    if (typeof first === 'number' && typeof v === 'number') {
      if (Math.abs(first - v) > tol) return false
    } else if (String(first) !== String(v)) {
      return false
    }
  }
  return true
}

function buildRows(
  listings: RankedListing[],
  saversByListing: Record<string, Saver[]>,
  commuteTargets: { saver: Saver; label: string }[],
  profileNames: Record<string, string>,
): BuiltRow[] {
  const out: BuiltRow[] = []

  // 1. Photo (always show: visual anchor)
  out.push({
    key: 'photo',
    label: 'Photo',
    values: listings.map((l) => {
      const photo = l.photos?.[0]
      return (
        <Avatar size="lg" className="!size-16 !rounded-xl">
          {photo ? <AvatarImage src={photo} alt={l.title} className="!rounded-xl" /> : null}
          <AvatarFallback className="!rounded-xl">
            <MapPin className="h-4 w-4" aria-hidden />
          </AvatarFallback>
        </Avatar>
      )
    }),
    equality: listings.map(() => Math.random()), // never equal: every photo is distinct
    differ: true,
    alwaysShow: true,
    pinned: true,
  })

  // 2. Score
  out.push(eqRow({
    key: 'score',
    label: 'Score',
    listings,
    keyOf: (l) => l.score?.score ?? null,
    render: (l) => {
      const s = l.score?.score ?? 0
      return <ScoreBadge score={s} size="lg" />
    },
    pinned: true,
    alwaysShow: true,
  }))

  // 3. Headline
  out.push(eqRow({
    key: 'headline',
    label: 'Headline',
    listings,
    keyOf: (l) => l.score?.headline ?? null,
    render: (l) => (
      <span className="text-[13px] leading-snug text-foreground">
        {l.score?.headline ?? <Missing />}
      </span>
    ),
    alwaysShow: true,
  }))

  // 4. Concerns
  out.push(eqRow({
    key: 'concerns',
    label: 'Concerns',
    listings,
    keyOf: (l) => l.score?.concerns ?? null,
    render: (l) =>
      l.score?.concerns ? (
        <span className="text-[13px] leading-snug text-warm-fg">{l.score.concerns}</span>
      ) : (
        <Missing label="none" />
      ),
    emphasis: 'warn',
  }))

  // 5. Price
  out.push(eqRow({
    key: 'price',
    label: 'Price',
    listings,
    keyOf: (l) => l.price_monthly ?? null,
    render: (l) => (
      <span className="tabular text-[16px] font-semibold text-foreground">
        {formatPrice(l.price_monthly)}
        <span className="text-muted-foreground/70">/mo</span>
      </span>
    ),
    pinned: true,
  }))

  // 6. Beds / baths / sqft
  out.push(eqRow({
    key: 'bbs',
    label: 'Beds · Baths · Sqft',
    listings,
    keyOf: (l) => `${formatBeds(l.beds)}|${formatBaths(l.baths)}|${l.sqft ?? ''}`,
    render: (l) => (
      <span className="tabular text-[13px]">
        <span className="font-medium text-foreground">{formatBeds(l.beds)}</span>
        <span aria-hidden className="mx-1.5 text-muted-foreground/60">·</span>
        <span>{formatBaths(l.baths)}</span>
        {l.sqft ? (
          <>
            <span aria-hidden className="mx-1.5 text-muted-foreground/60">·</span>
            <span className="text-muted-foreground">{formatSqft(l.sqft)}</span>
          </>
        ) : null}
      </span>
    ),
  }))

  // 7. Neighborhood + borough
  out.push(eqRow({
    key: 'hood',
    label: 'Neighborhood',
    listings,
    keyOf: (l) => `${l.neighborhood ?? ''}|${l.borough ?? ''}`,
    render: (l) => (
      <span>
        <span className="font-medium text-foreground">{l.neighborhood ?? <Missing />}</span>
        {l.borough ? (
          <span className="ml-1.5 text-muted-foreground">{l.borough}</span>
        ) : null}
      </span>
    ),
  }))

  // 8. Posted (red if >7d)
  const STALE_HOURS = 7 * 24
  out.push({
    key: 'posted',
    label: 'Posted',
    hint: '>7d gets red',
    values: listings.map((l) => {
      const stale = (l.freshness_hours ?? 0) > STALE_HOURS
      return (
        <span
          className={cn(
            'tabular text-[13px]',
            stale ? 'font-semibold text-destructive' : 'text-foreground',
          )}
        >
          {formatFreshness(l.freshness_hours)}
        </span>
      )
    }),
    equality: listings.map((l) => Math.round(l.freshness_hours ?? -1)),
    tol: 0.5,
    differ: !rowsEqual(
      listings.map((l) => Math.round(l.freshness_hours ?? -1)),
      0.5,
    ),
    emphasis: listings.some((l) => (l.freshness_hours ?? 0) > STALE_HOURS) ? 'danger' : 'normal',
    alwaysShow: true,
  })

  // 9. Source
  out.push(eqRow({
    key: 'source',
    label: 'Source',
    listings,
    keyOf: (l) => l.source,
    render: (l) => (
      <span className="tabular inline-flex rounded-full bg-secondary px-2 py-[3px] text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {formatSource(l.source)}
      </span>
    ),
  }))

  // 10. Subway
  out.push(eqRow({
    key: 'subway',
    label: 'Subway',
    listings,
    keyOf: (l) => l.nearest_subway ? `${l.nearest_subway.name}|${l.nearest_subway.distance_m}` : null,
    render: (l) => {
      const s = l.nearest_subway
      if (!s) return <Missing />
      return (
        <span className="tabular text-[13px]">
          <span className="font-medium text-foreground">{s.lines.join('/')} {s.name}</span>
          <span className="ml-1.5 text-muted-foreground">{formatDistance(s.distance_m)}</span>
        </span>
      )
    },
  }))

  // 11. Commute (one row per target). Nominal display since we don't compute
  // per-listing minutes here; we surface what we have.)
  for (const target of commuteTargets) {
    out.push({
      key: `commute-${target.saver}-${target.label}`,
      label: `Commute · ${profileNames[target.saver] ?? target.saver}`,
      hint: target.label,
      values: listings.map((l) => {
        // Heuristic minute estimate: subway distance + line proxy. We don't
        // claim door-to-door precision (per PRODUCT.md). If we lack data,
        // say so explicitly.
        const est = estimateCommuteMinutes(l, target)
        if (est == null) {
          return <Missing label="unknown" />
        }
        return (
          <span className="tabular text-[13px]">
            <span className="font-medium text-foreground">~{est} min</span>
            <span className="ml-1.5 text-[11px] text-muted-foreground">subway</span>
          </span>
        )
      }),
      equality: listings.map((l) => estimateCommuteMinutes(l, target)),
      tol: 1,
      differ: !rowsEqual(
        listings.map((l) => estimateCommuteMinutes(l, target)),
        1,
      ),
    })
  }

  // 12. HPD violations (red if >5)
  out.push({
    key: 'hpd',
    label: 'HPD violations',
    hint: 'last 12mo',
    values: listings.map((l) => {
      const c = l.hpd_count_12mo ?? null
      const flagged = (c ?? 0) > 5
      if (c == null) return <Missing />
      return (
        <span
          className={cn(
            'tabular text-[13px] font-medium',
            flagged ? 'font-semibold text-destructive' : 'text-foreground',
          )}
        >
          {c}
          {flagged ? <span className="ml-1.5 text-[11px] uppercase tracking-[0.06em]">over 5</span> : null}
        </span>
      )
    }),
    equality: listings.map((l) => l.hpd_count_12mo ?? null),
    differ: !rowsEqual(listings.map((l) => l.hpd_count_12mo ?? null)),
    emphasis: listings.some((l) => (l.hpd_count_12mo ?? 0) > 5) ? 'danger' : 'normal',
  })

  // 13. Rent stabilized
  out.push(eqRow({
    key: 'stabilized',
    label: 'Rent-stabilized',
    listings,
    keyOf: (l) => (l.rent_stabilized == null ? null : l.rent_stabilized ? 'yes' : 'no'),
    render: (l) => {
      if (l.rent_stabilized == null) return <Missing />
      const yes = l.rent_stabilized
      return (
        <span
          className={cn(
            'tabular inline-flex rounded-full px-2 py-[3px] text-[11px] font-medium uppercase tracking-[0.06em]',
            yes ? 'bg-cool text-cool-fg' : 'bg-secondary text-muted-foreground',
          )}
        >
          {yes ? 'yes' : 'no'}
        </span>
      )
    },
  }))

  // 14. Vibe bars (4 mini SVG bars in one row: walkability, quietness, cafes, greenness)
  out.push({
    key: 'vibe',
    label: 'Vibe',
    hint: 'walk · quiet · cafe · green',
    values: listings.map((l) => <VibeMini vibe={l.vibe} />),
    equality: listings.map((l) => vibeKey(l.vibe)),
    tol: VIBE_EPS,
    differ: !vibesEqual(listings.map((l) => l.vibe), VIBE_EPS),
  })

  // 15. Photos count
  out.push({
    key: 'photoCount',
    label: 'Photos',
    values: listings.map((l) => {
      const n = l.photos?.length ?? 0
      if (n === 0) {
        return (
          <Link
            href={`/listing/${l.id}`}
            className="text-[12px] text-warm-fg underline-offset-4 hover:underline"
          >
            none
          </Link>
        )
      }
      return <span className="tabular text-[13px] font-medium text-foreground">{n}</span>
    }),
    equality: listings.map((l) => l.photos?.length ?? 0),
    differ: !rowsEqual(listings.map((l) => l.photos?.length ?? 0)),
    muted: true,
  })

  // 16. Contact (phone + email + agent + agency)
  out.push({
    key: 'contact',
    label: 'Contact',
    values: listings.map((l) => <ContactCell listing={l} />),
    equality: listings.map((l) => contactKey(l)),
    differ: !rowsEqual(listings.map((l) => contactKey(l))),
  })

  // 17. Application
  out.push({
    key: 'application',
    label: 'Application',
    values: listings.map((l) => <ApplicationCell listing={l} />),
    equality: listings.map((l) => applicationKey(l)),
    differ: !rowsEqual(listings.map((l) => applicationKey(l))),
  })

  // 18. Saved by
  out.push({
    key: 'savedBy',
    label: 'Saved by',
    values: listings.map((l) => (
      <SaversChips savers={saversByListing[l.id] ?? []} profileNames={profileNames} />
    )),
    equality: listings.map((l) => (saversByListing[l.id] ?? []).slice().sort().join('|')),
    differ: !rowsEqual(listings.map((l) => (saversByListing[l.id] ?? []).slice().sort().join('|'))),
    muted: true,
  })

  // 19. Open original
  out.push({
    key: 'open',
    label: 'Open',
    values: listings.map((l) => (
      <a
        href={l.source_url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-[12.5px] font-medium text-foreground underline-offset-4 hover:underline"
      >
        {formatSource(l.source)}
        <ExternalLink className="h-3 w-3" aria-hidden />
      </a>
    )),
    equality: listings.map((l) => l.source_url),
    differ: true, // every URL distinct
    muted: true,
    alwaysShow: true,
  })

  return out
}

/* -------------------- helpers -------------------- */

function eqRow<T>({
  key,
  label,
  hint,
  listings,
  keyOf,
  render,
  emphasis,
  pinned,
  alwaysShow,
  muted,
}: {
  key: string
  label: string
  hint?: string
  listings: RankedListing[]
  keyOf: (l: RankedListing) => T
  render: (l: RankedListing) => React.ReactNode
  emphasis?: 'normal' | 'warn' | 'danger'
  pinned?: boolean
  alwaysShow?: boolean
  muted?: boolean
}): BuiltRow {
  const equality = listings.map((l) => {
    const v = keyOf(l)
    if (v == null) return null
    if (typeof v === 'number') return v
    return String(v).trim().toLowerCase()
  })
  return {
    key,
    label,
    hint,
    values: listings.map((l) => render(l)),
    equality,
    differ: !rowsEqual(equality),
    emphasis,
    pinned,
    alwaysShow,
    muted,
  }
}

function Missing({ label = 'unknown' }: { label?: string }) {
  return <span className="text-[13px] text-muted-foreground">{label}</span>
}

/* -------------------- vibe mini chart -------------------- */

function VibeMini({ vibe }: { vibe: RankedListing['vibe'] }) {
  if (!vibe) return <Missing />
  const v = (n: number | null | undefined) => Math.max(0, Math.min(1, n ?? 0))
  const bars = [
    { label: 'walk', value: v(vibe.walkability) },
    { label: 'quiet', value: v(vibe.noise == null ? null : 1 - vibe.noise) },
    { label: 'cafe', value: v(vibe.cafes) },
    { label: 'green', value: v(vibe.greenness) },
  ]
  // Inline SVG: 4 vertical bars, 0..28px tall, 6px wide, 4px gap.
  const W = 6
  const GAP = 4
  const H = 28
  const totalW = bars.length * W + (bars.length - 1) * GAP
  return (
    <div className="flex items-end gap-2">
      <svg
        width={totalW}
        height={H}
        viewBox={`0 0 ${totalW} ${H}`}
        aria-label="vibe scores"
        className="text-foreground/80"
      >
        {bars.map((b, i) => {
          const x = i * (W + GAP)
          const h = Math.max(2, Math.round(b.value * H))
          const y = H - h
          return (
            <g key={b.label}>
              <rect x={x} y={0} width={W} height={H} className="fill-secondary" rx={1} />
              <rect x={x} y={y} width={W} height={h} className="fill-current" rx={1} />
            </g>
          )
        })}
      </svg>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="tabular cursor-help text-[10.5px] uppercase tracking-[0.06em] text-muted-foreground">
              {bars.map((b) => Math.round(b.value * 99)).join(' · ')}
            </span>
          }
        />
        <TooltipContent>
          {bars.map((b) => `${b.label} ${Math.round(b.value * 99)}`).join(' · ')}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

function vibeKey(v: RankedListing['vibe']): string {
  if (!v) return 'null'
  // Quantize to 0..20 buckets so tiny differences don't always flag.
  const q = (n: number | null | undefined) => (n == null ? 'x' : Math.round(n * 20))
  return [q(v.walkability), q(v.noise == null ? null : 1 - v.noise), q(v.cafes), q(v.greenness)].join(',')
}

function vibesEqual(vibes: RankedListing['vibe'][], eps: number): boolean {
  if (vibes.length <= 1) return true
  const first = vibes[0]
  for (let i = 1; i < vibes.length; i++) {
    const v = vibes[i]
    if (first == null || v == null) {
      if (first !== v) return false
      continue
    }
    const fields: Array<keyof NonNullable<RankedListing['vibe']>> = [
      'walkability',
      'noise',
      'cafes',
      'greenness',
    ]
    for (const f of fields) {
      const a = (first[f] as number | null | undefined) ?? null
      const b = (v[f] as number | null | undefined) ?? null
      if (a == null || b == null) {
        if (a !== b) return false
        continue
      }
      if (Math.abs(a - b) > eps) return false
    }
  }
  return true
}

/* -------------------- contact + application cells -------------------- */

function ContactCell({ listing }: { listing: RankedListing }) {
  const c = listing.contact
  if (!c || (!c.phone && !c.email && !c.name)) {
    return <Missing label="no contact" />
  }
  return (
    <div className="space-y-0.5">
      {c.name ? (
        <div className="flex items-center gap-1.5 text-[12.5px]">
          <span className="font-medium text-foreground">{c.name}</span>
          {c.agency ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="max-w-[120px] cursor-help truncate text-[11.5px] text-muted-foreground">
                    {c.agency}
                  </span>
                }
              />
              <TooltipContent>{c.agency}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {c.phone ? (
        <a
          href={`tel:${c.phone}`}
          className="tabular block text-[12.5px] font-medium text-foreground underline-offset-4 hover:underline"
        >
          {c.phone}
        </a>
      ) : null}
      {c.email ? (
        <a
          href={`mailto:${c.email}`}
          className="block truncate text-[12.5px] text-foreground underline-offset-4 hover:underline"
        >
          {c.email}
        </a>
      ) : null}
    </div>
  )
}

function ApplicationCell({ listing }: { listing: RankedListing }) {
  const a = listing.application
  const [open, setOpen] = useState(false)
  if (!a) return <Missing />
  const fee = a.fee ?? null
  const broker = formatBrokerFee(a) || (a.broker_fee_pct === 0 ? 'No broker fee' : '')
  const docs = a.required_docs ?? []
  return (
    <div className="space-y-1">
      <div className="tabular flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12.5px]">
        {fee != null ? (
          <span>
            <span className="text-muted-foreground">fee </span>
            <span className="font-medium text-foreground">{fee === 0 ? '$0' : `$${fee}`}</span>
          </span>
        ) : null}
        {broker ? (
          <span className={cn(a.broker_fee_pct && a.broker_fee_pct > 0 ? 'text-warm-fg' : 'text-foreground')}>
            {broker}
          </span>
        ) : null}
      </div>
      {docs.length > 0 ? (
        <div>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex cursor-pointer items-center gap-0.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            {docs.length} required docs
            {open ? <ChevronUp className="h-3 w-3" aria-hidden /> : <ChevronDown className="h-3 w-3" aria-hidden />}
          </button>
          {open ? (
            <ul className="mt-1 space-y-0.5 text-[11.5px] text-muted-foreground">
              {docs.map((d) => (
                <li key={d} className="flex items-baseline gap-1.5">
                  <span aria-hidden className="text-muted-foreground/50">·</span>
                  <span>{d}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {a.url ? (
        <a
          href={a.url}
          target="_blank"
          rel="noopener noreferrer"
          className="tabular inline-flex h-7 items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:bg-secondary"
        >
          Apply <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      ) : null}
    </div>
  )
}

/* -------------------- equality keys -------------------- */

function contactKey(l: RankedListing): string {
  const c = l.contact ?? {}
  return [c.name ?? '', c.phone ?? '', c.email ?? '', c.agency ?? ''].join('|').toLowerCase()
}

function applicationKey(l: RankedListing): string {
  const a = l.application ?? {}
  return [
    a.fee ?? '',
    a.broker_fee_pct ?? '',
    (a.required_docs ?? []).join(','),
    a.url ?? '',
  ].join('|').toLowerCase()
}

/* -------------------- commute estimate -------------------- */

/**
 * Honest, low-confidence commute estimate. Per PRODUCT.md we don't pretend
 * door-to-door precision: if we don't have the listing's lat/lng or its
 * subway station, we return null. When we have the station, estimate as:
 *   walk-to-station (≈ distance/80m-per-min) + a fixed commute proxy by
 *   borough → Manhattan-FiDi anchor. This is enough to let the comparison
 *   surface a per-saver minute estimate (e.g. "saver-A: 22 min" vs
 *   "saver-B: 47 min").
 */
function estimateCommuteMinutes(l: RankedListing, _target: { saver: Saver; label: string }): number | null {
  const subway = l.nearest_subway
  if (!subway) return null
  const walkMin = Math.max(1, Math.round(subway.distance_m / 80))
  // Borough proxy minutes to a generic Manhattan anchor.
  const boroughProxy: Record<string, number> = {
    Manhattan: 14,
    Brooklyn: 26,
    Queens: 28,
    Bronx: 32,
    'Staten Island': 55,
  }
  const proxy = boroughProxy[l.borough ?? ''] ?? 30
  return walkMin + proxy
}
