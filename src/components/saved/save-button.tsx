'use client'

import { useState, useTransition } from 'react'
import { Heart } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

type Saver = 'inaan' | 'mekonnen'

type Props = {
  listing_id: string
  saved_by: Saver
  initial: boolean
  /** Visual variant for the button surface. */
  variant?: 'default' | 'onPhoto'
  /** Tighter version (no label, just heart). */
  compact?: boolean
}

/**
 * The save button the integrator drops into the listing card / detail page.
 * Optimistic toggle: flips state, fires the request, reverts and toasts on
 * error. Heart fills for "saved", outline for "not saved".
 */
export function SaveButton({
  listing_id,
  saved_by,
  initial,
  variant = 'default',
  compact = false,
}: Props) {
  const [saved, setSaved] = useState(initial)
  const [isPending, startTransition] = useTransition()

  function toggle(e: React.MouseEvent) {
    // Stop the parent <Link> from navigating when the heart sits inside a card.
    e.preventDefault()
    e.stopPropagation()
    if (isPending) return

    const next = !saved
    setSaved(next)

    startTransition(async () => {
      try {
        const res = await fetch('/api/save', {
          method: next ? 'POST' : 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ listing_id, saved_by }),
        })
        if (!res.ok) {
          throw new Error(`save failed: ${res.status}`)
        }
        toast.success(next ? `Saved for ${saver_label(saved_by)}.` : `Removed from ${saver_label(saved_by)}'s list.`)
      } catch (err) {
        setSaved(!next)
        toast.error(err instanceof Error ? err.message : 'Save failed.')
      }
    })
  }

  const label = saved ? 'Saved' : 'Save'

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={saved}
      aria-label={saved ? `Remove from ${saver_label(saved_by)}'s saved` : `Save for ${saver_label(saved_by)}`}
      disabled={isPending}
      className={cn(
        'group/save inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full',
        'transition-[background-color,border-color,color,transform] duration-200 ease-out',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        'active:scale-[0.96]',
        compact ? 'h-7 w-7 justify-center p-0' : 'h-8 px-3 text-[12px] font-medium',
        variant === 'onPhoto'
          ? 'border border-foreground/15 bg-background/80 text-foreground backdrop-blur-sm hover:bg-background'
          : 'border border-border bg-surface-2 text-foreground hover:bg-secondary',
        saved && 'text-accent-foreground',
        isPending && 'opacity-70',
      )}
    >
      <Heart
        className={cn(
          'h-3.5 w-3.5 transition-[fill,stroke] duration-200',
          saved ? 'fill-accent stroke-accent' : 'fill-transparent stroke-current',
        )}
        aria-hidden
      />
      {!compact ? <span>{label}</span> : null}
    </button>
  )
}

function saver_label(s: Saver): string {
  return s === 'inaan' ? 'Inaan' : 'Mekonnen'
}
