'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Floating "+N new since opened" indicator.
 *
 * Strategy:
 *   - Snapshot the latest `posted_at` (or `last_seen_at`) timestamp the page
 *     was rendered with at mount time.
 *   - Every 60s poll `/api/feed-since?since=<iso>` for a count of newer-or-
 *     refreshed-since rows.
 *   - When >0, render a chip at the top-right of the feed: clicking calls
 *     `router.refresh()` (which re-runs the server component → fresh feed
 *     + new snapshot). We also bump the `since` timestamp on refresh so the
 *     chip resets cleanly.
 *
 * Polling happens client-side only. We tolerate failed fetches silently
 * (network blip → no chip → no harm done).
 */
export function NewListingsPoller({ initialLatest }: { initialLatest: string | null }) {
  const router = useRouter()
  // Track the cutoff that the next poll uses. Starts at `initialLatest`,
  // bumps to `now` on each refresh so the count resets.
  const sinceRef = useRef<string | null>(initialLatest)
  const [count, setCount] = useState(0)

  useEffect(() => {
    // Reset when the server passes a fresh cutoff (e.g. after a router
    // refresh). React's effect dep on the prop is the right re-run trigger.
    sinceRef.current = initialLatest
    setCount(0)
  }, [initialLatest])

  useEffect(() => {
    let cancelled = false

    async function tick() {
      const since = sinceRef.current
      if (!since) return
      try {
        const res = await fetch(`/api/feed-since?since=${encodeURIComponent(since)}`, {
          // Force a fresh fetch — Vercel's runtime won't dedupe poll responses
          // across the 60s interval, but the route itself is uncached so this
          // just keeps any future Cloudflare-style edge cache off our back.
          cache: 'no-store',
        })
        if (!res.ok) return
        const j = (await res.json()) as { count?: number }
        if (cancelled) return
        if (typeof j.count === 'number') setCount(j.count)
      } catch {
        // Network blip — keep silent and try again next interval.
      }
    }

    // Don't tick immediately on mount — the page already rendered with the
    // latest data, so a 0-count would be expected.
    const id = setInterval(tick, 60_000)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  function handleClick() {
    // Bump the snapshot so the chip resets after refresh.
    sinceRef.current = new Date().toISOString()
    setCount(0)
    router.refresh()
  }

  if (count <= 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-16 z-20 flex justify-center px-4 sm:top-20">
      <button
        type="button"
        onClick={handleClick}
        className={cn(
          'pointer-events-auto inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-foreground px-4 text-[12.5px] font-medium text-background shadow-lg transition-opacity hover:opacity-90',
          'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-2',
        )}
        aria-label={`${count} new listings — refresh feed`}
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>
          +{count} new listing{count === 1 ? '' : 's'}
        </span>
        <span className="text-background/70">— refresh feed</span>
      </button>
    </div>
  )
}
