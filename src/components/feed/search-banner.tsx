'use client'

import { useRouter } from 'next/navigation'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { filtersToChips, type ExtractedFilters, type FilterChipKey } from '@/lib/search'

/**
 * Renders the "Searching for: <intent>" line plus a row of removable chips.
 * Each chip click strips that field from the extracted filters and rewrites
 * the URL with an updated `q=`. Strategy: we serialize the modified filters
 * back into a short NL string by dropping the relevant phrase — but that's
 * lossy. Instead we keep the original `q=` and let the next render extract
 * again, but pass an override (`exclude`) the page reads to mask out the
 * dropped chip locally. For v0 the simpler approach: clicking a chip
 * navigates to a clean `/` (clears all filters) — except for the explicit
 * "Clear" button, every chip click drops just that filter via a local
 * cache key.
 *
 * To keep this self-contained and honest (per "show what the LLM extracted
 * so the user can correct course"), each chip click triggers a callback
 * that the parent wires to whatever its filter-removal strategy is. If no
 * callback is provided, chips render but are non-interactive.
 */
export function SearchBanner({
  filters,
  query,
  onRemoveChip,
  onClear,
  resultCount,
}: {
  filters: ExtractedFilters
  /** The original NL query (so "Clear" knows what to drop). */
  query?: string
  /** Callback when the user removes a chip. Parent updates URL accordingly. */
  onRemoveChip?: (key: FilterChipKey) => void
  /** Callback for the Clear button. Default: navigate to "/". */
  onClear?: () => void
  /** Optional result count to surface inline (e.g. "12 matches"). */
  resultCount?: number
}) {
  const router = useRouter()
  const chips = filtersToChips(filters)

  function handleClear() {
    if (onClear) onClear()
    else router.push('/')
  }

  return (
    <div className="mb-5 rounded-2xl border border-border bg-surface-2 px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="flex items-baseline gap-2 text-[13px]">
          <span className="text-muted-foreground">Searching for:</span>
          <span className="serif italic text-foreground">
            {filters.intent_summary || query || ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {typeof resultCount === 'number' ? (
            <span className="tabular text-[12px] text-muted-foreground">
              <span className="font-medium text-foreground">{resultCount}</span> match
              {resultCount === 1 ? '' : 'es'}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleClear}
            className="tabular cursor-pointer text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            Clear
          </button>
        </div>
      </div>
      {chips.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {chips.map((c, i) => {
            const removable = !!onRemoveChip
            return (
              <button
                key={`${c.key}-${i}`}
                type="button"
                disabled={!removable}
                onClick={() => onRemoveChip?.(c.key)}
                className={cn(
                  'tabular inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-0.5 text-[11px] font-medium text-foreground',
                  removable
                    ? 'cursor-pointer transition-colors hover:bg-secondary'
                    : 'cursor-default'
                )}
                aria-label={removable ? `Remove ${c.label}` : c.label}
              >
                <span>{c.label}</span>
                {removable ? <X className="h-2.5 w-2.5 text-muted-foreground" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
