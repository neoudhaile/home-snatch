'use client'

/**
 * "Scrape now" / Refresh button. Lives in the feed header. POSTs to
 * /api/refresh which runs the LIGHTWEIGHT direct scrapers (Craigslist /
 * Reddit / Listings Project) — no Apify. Apify runs only from the GH Actions
 * cron because of Vercel's 60s function cap.
 *
 * UX notes:
 *   - 30s debounce via localStorage `homesnatch:last-scrape-at` so a stuck
 *     button can't fire 5x.
 *   - Toasts: "Scraping…" → "Found N new listings" / "No new listings".
 *   - On success, calls router.refresh() so the feed re-renders.
 *   - Respects prefers-reduced-motion: spinner stops spinning if user opted
 *     out of motion.
 *   - Errors stay friendly: "Couldn't reach Craigslist, others worked"
 *     synthesized from per-source counts. Never raw stack traces.
 */

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

const LAST_SCRAPE_KEY = 'homesnatch:last-scrape-at'
const DEBOUNCE_MS = 30_000

const SOURCE_LABELS: Record<string, string> = {
  craigslist: 'Craigslist',
  reddit: 'Reddit',
  'listings-project': 'Listings Project',
}

type RefreshResponse = {
  ingested: number
  by_source: Record<string, number>
  duration_ms: number
}

export function ScrapeButton() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(false)

  // Detect prefers-reduced-motion so the spinner can stop animating for
  // users who opted out.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReducedMotion(mq.matches)
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  const onClick = useCallback(async () => {
    if (isLoading) return

    // Debounce against rapid double-clicks.
    try {
      const last = localStorage.getItem(LAST_SCRAPE_KEY)
      if (last) {
        const ago = Date.now() - parseInt(last, 10)
        if (Number.isFinite(ago) && ago < DEBOUNCE_MS) {
          const wait = Math.ceil((DEBOUNCE_MS - ago) / 1000)
          toast.message(`Easy — try again in ${wait}s.`)
          return
        }
      }
    } catch {
      /* localStorage unavailable; proceed anyway */
    }

    setIsLoading(true)
    const toastId = toast.loading('Scraping for new listings…')
    try {
      const res = await fetch('/api/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) {
        const body = await res.text().catch(() => '')
        toast.error(
          body
            ? `Refresh failed: ${body.slice(0, 120)}`
            : `Refresh failed (HTTP ${res.status}).`,
          { id: toastId },
        )
        return
      }

      const data = (await res.json()) as RefreshResponse
      try {
        localStorage.setItem(LAST_SCRAPE_KEY, String(Date.now()))
      } catch {
        /* ignore */
      }

      // Build the friendly result message.
      const hits = Object.entries(data.by_source ?? {}).filter(([, n]) => (n as number) > 0)
      const misses = Object.entries(data.by_source ?? {}).filter(
        ([, n]) => (n as number) === 0,
      )

      if (data.ingested === 0) {
        const missLabels = misses.map(([k]) => SOURCE_LABELS[k] ?? k).join(', ')
        const detail = missLabels ? ` (no hits from ${missLabels})` : ''
        toast.message(`No new listings yet${detail}.`, { id: toastId })
      } else {
        const hitLabels = hits.map(([k, n]) => `${SOURCE_LABELS[k] ?? k}: ${n}`).join(', ')
        toast.success(
          `Found ${data.ingested} listing${data.ingested === 1 ? '' : 's'}${
            hitLabels ? ` — ${hitLabels}` : ''
          }.`,
          { id: toastId },
        )
        router.refresh()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error.'
      toast.error(`Couldn't refresh: ${msg.slice(0, 120)}`, { id: toastId })
    } finally {
      setIsLoading(false)
    }
  }, [isLoading, router])

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLoading}
      aria-label="Scrape new listings now"
      title={isLoading ? 'Scraping…' : 'Scrape now'}
      className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary disabled:cursor-progress disabled:opacity-70"
    >
      <RefreshCw
        className={[
          'h-3.5 w-3.5',
          isLoading && !reducedMotion ? 'animate-spin' : '',
        ]
          .filter(Boolean)
          .join(' ')}
        aria-hidden
      />
      <span className="hidden sm:inline">{isLoading ? 'Scraping' : 'Refresh'}</span>
    </button>
  )
}
