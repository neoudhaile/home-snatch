'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, Search, X } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import {
  CANONICAL_NEIGHBORHOODS,
  neighborhoodsByBorough,
  resolveNeighborhood,
  type Borough,
  type CanonicalNeighborhood,
} from '@/lib/neighborhoods'
import { AreasModal } from '@/components/shell/areas-modal'

/**
 * Compact chip row for picking neighborhoods directly on the feed.
 *
 * State source of truth = URL `?neighborhoods=`. We never mirror this in
 * component state — every click pushes a new URL and React re-renders against
 * the new query, which keeps the active set, the chip styling, the SQL
 * filter, and the empty-state copy in lockstep.
 *
 * Default-rendered set is the union of:
 *   1. The user's joint preferred_areas (so "Bed-Stuy" stays even when 0
 *      listings remain — they may want to keep the chip pinned and check
 *      back later)
 *   2. Every neighborhood with ≥3 active listings in the count map (so the
 *      user discovers fresh inventory in areas they hadn't asked for)
 *
 * Click toggles in/out. The "+ Add area" trailing chip opens a search-then-pick
 * popover spanning all CANONICAL_NEIGHBORHOODS. "Edit defaults" opens the
 * modal that rewrites the user's profile.preferred_areas.
 */
export function NeighborhoodChips({
  jointAreas,
  selectedAreas,
  counts,
  totalActiveCount,
}: {
  /** The user's joint preferred_areas (display form, e.g. "Bed-Stuy"). */
  jointAreas: string[]
  /** Which areas are currently active in the URL filter. Empty = "All NYC". */
  selectedAreas: string[]
  /** canonical → count, computed off the active+fresh window. */
  counts: Record<string, number>
  /** Total active listings across the window — used by the "All NYC" pill. */
  totalActiveCount: number
}) {
  const router = useRouter()
  const params = useSearchParams()

  // Build a set of canonical names that should appear as chips by default —
  // joint areas (always shown) plus high-volume neighborhoods (≥3 active).
  // Selected areas are always shown so the user can deselect them.
  const visibleChips = useMemo(() => {
    const out = new Map<string, CanonicalNeighborhood>()
    const add = (name: string) => {
      const hit = resolveNeighborhood(name)
      if (hit) out.set(hit.canonical, hit)
    }
    for (const a of jointAreas) add(a)
    for (const a of selectedAreas) add(a)
    for (const [canonical, n] of Object.entries(counts)) {
      if (n >= 3) {
        const hit = resolveNeighborhood(canonical)
        if (hit) out.set(hit.canonical, hit)
      }
    }
    // Stable ordering: joint areas first (in their joint order), then
    // remaining by descending count.
    const seen = new Set<string>()
    const ordered: CanonicalNeighborhood[] = []
    for (const a of jointAreas) {
      const hit = resolveNeighborhood(a)
      if (hit && out.has(hit.canonical) && !seen.has(hit.canonical)) {
        ordered.push(hit)
        seen.add(hit.canonical)
      }
    }
    const remaining = Array.from(out.values())
      .filter((n) => !seen.has(n.canonical))
      .sort((a, b) => (counts[b.canonical] ?? 0) - (counts[a.canonical] ?? 0))
    ordered.push(...remaining)
    return ordered
  }, [jointAreas, selectedAreas, counts])

  // Resolve each selected area string to its canonical so chip click-toggle
  // semantics are stable regardless of which alias the URL holds.
  const selectedSet = useMemo(() => {
    const s = new Set<string>()
    for (const a of selectedAreas) {
      const hit = resolveNeighborhood(a)
      if (hit) s.add(hit.canonical)
    }
    return s
  }, [selectedAreas])

  const pushSelection = useCallback(
    (next: CanonicalNeighborhood[]) => {
      const url = new URLSearchParams(params.toString())
      url.delete('show_all')
      url.delete('welcome')
      if (next.length === 0) {
        url.delete('neighborhoods')
        // No selection = back to user's joint defaults (handled server-side).
      } else {
        url.set('neighborhoods', next.map((n) => n.display).join(','))
      }
      const qs = url.toString()
      router.push(qs ? `/?${qs}` : '/')
    },
    [params, router],
  )

  const onToggle = useCallback(
    (n: CanonicalNeighborhood) => {
      // Build the next selection from the current URL. If `selectedAreas` is
      // empty (i.e. we were on the joint default), seed with jointAreas so
      // toggling off Bed-Stuy doesn't accidentally drop everything else.
      const seed: CanonicalNeighborhood[] =
        selectedAreas.length > 0
          ? (selectedAreas
              .map((a) => resolveNeighborhood(a))
              .filter((x): x is CanonicalNeighborhood => x != null) as CanonicalNeighborhood[])
          : (jointAreas
              .map((a) => resolveNeighborhood(a))
              .filter((x): x is CanonicalNeighborhood => x != null) as CanonicalNeighborhood[])
      const has = seed.some((s) => s.canonical === n.canonical)
      const next = has
        ? seed.filter((s) => s.canonical !== n.canonical)
        : [...seed, n]
      pushSelection(next)
    },
    [selectedAreas, jointAreas, pushSelection],
  )

  const onShowAll = useCallback(() => {
    const url = new URLSearchParams(params.toString())
    url.delete('neighborhoods')
    url.delete('welcome')
    url.set('show_all', '1')
    router.push(`/?${url.toString()}`)
  }, [params, router])

  const allActive = selectedAreas.length === 0 && params.get('show_all') !== '1' && jointAreas.length === 0
  const showingAll = params.get('show_all') === '1'

  return (
    <div className="mb-5 flex flex-col gap-2">
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin -mx-1 px-1">
        {/* "All NYC" pill — toggled by `?show_all=1` */}
        <ChipButton
          active={showingAll || allActive}
          onClick={onShowAll}
          count={totalActiveCount}
          label="All NYC"
        />

        {/* Per-neighborhood chips */}
        {visibleChips.map((n) => (
          <ChipButton
            key={n.canonical}
            active={selectedSet.has(n.canonical)}
            onClick={() => onToggle(n)}
            count={counts[n.canonical] ?? 0}
            label={n.display}
          />
        ))}

        <AddAreaPopover
          existing={visibleChips}
          onAdd={(n) => onToggle(n)}
        />
      </div>

      {jointAreas.length > 0 ? (
        <div className="flex items-center gap-3 text-[12px] text-muted-foreground">
          <span>
            Showing {selectedAreas.length === 0 && !showingAll ? 'your areas' : `${selectedAreas.length || 'all NYC'}`}.
          </span>
          <AreasModal
            trigger={
              <button
                type="button"
                className="cursor-pointer text-foreground underline-offset-[3px] transition-colors hover:underline"
              >
                Edit defaults
              </button>
            }
          />
        </div>
      ) : null}
    </div>
  )
}

/** A single neighborhood chip. Active state mirrors the URL filter. */
function ChipButton({
  active,
  onClick,
  count,
  label,
}: {
  active: boolean
  onClick: () => void
  count: number
  label: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'tabular inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[12.5px] font-medium transition-colors',
        active
          ? 'border-foreground bg-foreground text-background'
          : 'border-border bg-surface-2 text-foreground hover:bg-secondary',
      )}
      aria-pressed={active}
    >
      <span>{label}</span>
      <span
        className={cn(
          'tabular text-[11px]',
          active ? 'text-background/70' : 'text-muted-foreground',
        )}
      >
        {count}
      </span>
      {active ? (
        <X
          className={cn('h-3 w-3', active ? 'text-background/70' : 'text-muted-foreground')}
          aria-hidden
        />
      ) : null}
    </button>
  )
}

/**
 * "+ Add area" popover. Renders all CANONICAL_NEIGHBORHOODS grouped by borough
 * with a search box that filters by canonical/display/alias substring.
 */
function AddAreaPopover({
  existing,
  onAdd,
}: {
  existing: CanonicalNeighborhood[]
  onAdd: (n: CanonicalNeighborhood) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const grouped = useMemo(() => neighborhoodsByBorough(), [])
  const existingSet = useMemo(
    () => new Set(existing.map((e) => e.canonical)),
    [existing],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return grouped
    const out: Record<Borough, CanonicalNeighborhood[]> = {
      Manhattan: [],
      Brooklyn: [],
      Queens: [],
      Bronx: [],
      'Staten Island': [],
    }
    for (const b of Object.keys(grouped) as Borough[]) {
      out[b] = grouped[b].filter((n) => {
        const names = [n.canonical, n.display, ...n.aliases]
        return names.some((x) => x.toLowerCase().includes(q))
      })
    }
    return out
  }, [grouped, query])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'tabular inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-dashed border-border bg-transparent px-3 text-[12.5px] font-medium text-muted-foreground transition-colors',
          'hover:border-foreground hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        )}
        aria-label="Add area"
      >
        <Plus className="h-3.5 w-3.5" aria-hidden />
        <span>Add area</span>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search neighborhoods…"
            className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1">
          {(Object.keys(filtered) as Borough[]).map((borough) => {
            const list = filtered[borough]
            if (list.length === 0) return null
            return (
              <div key={borough} className="px-1 py-1">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {borough}
                </div>
                <div className="flex flex-col">
                  {list.map((n) => {
                    const already = existingSet.has(n.canonical)
                    return (
                      <button
                        key={n.canonical}
                        onClick={() => {
                          if (already) return
                          onAdd(n)
                          setOpen(false)
                          setQuery('')
                        }}
                        disabled={already}
                        className={cn(
                          'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px]',
                          already
                            ? 'cursor-default text-muted-foreground'
                            : 'cursor-pointer text-foreground hover:bg-secondary',
                        )}
                      >
                        <span>{n.display}</span>
                        {already ? (
                          <span className="text-[11px] text-muted-foreground">added</span>
                        ) : null}
                      </button>
                    )
                  })}
                </div>
              </div>
            )
          })}
          {Object.values(filtered).every((l) => l.length === 0) ? (
            <div className="px-3 py-6 text-center text-[12.5px] text-muted-foreground">
              No matches.
            </div>
          ) : null}
        </div>
        <div className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          {CANONICAL_NEIGHBORHOODS.length} neighborhoods catalogued.
          {/* Cheap reminder of catalog size — useful while the alias map is
              still being filled out. Render also helps validate the import
              didn't fall over at build time. */}
        </div>
      </PopoverContent>
    </Popover>
  )
}

