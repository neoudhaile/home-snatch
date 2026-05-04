'use client'

import Link from 'next/link'
import { useState } from 'react'
import { Plus, Printer, Share2, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

type Props = {
  count: number
  highlight: boolean
  onHighlightChange: (next: boolean) => void
}

export function CompareHeader({ count, highlight, onHighlightChange }: Props) {
  const [sharing, setSharing] = useState(false)

  async function copyShare() {
    if (typeof window === 'undefined') return
    try {
      setSharing(true)
      await navigator.clipboard.writeText(window.location.href)
      toast.success('Link copied.')
    } catch {
      toast.error('Could not copy link.')
    } finally {
      setSharing(false)
    }
  }

  function printPage() {
    if (typeof window !== 'undefined') window.print()
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 print:hidden">
      <div className="min-w-0 flex-1">
        <h1 className="serif text-[28px] leading-none tracking-[-0.01em] text-foreground sm:text-[36px]">
          compare {count > 0 ? <span className="tabular not-italic">{count}</span> : null}{' '}
          <span className="text-muted-foreground">listings</span>
        </h1>
        <p className="tabular mt-1 text-[12px] text-muted-foreground">
          Find the row where they differ. Strip the rest.
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        <label
          className={cn(
            'tabular flex h-8 cursor-pointer items-center gap-2 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground',
            'transition-colors hover:bg-secondary',
          )}
        >
          <Sparkles className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
          <span className="hidden sm:inline">Highlight differences</span>
          <span className="sm:hidden">Diff</span>
          <Switch
            checked={highlight}
            onCheckedChange={onHighlightChange}
            aria-label="Highlight differences"
          />
        </label>

        <Link
          href="/saved"
          className="tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden />
          <span>Add another</span>
        </Link>

        <button
          type="button"
          onClick={printPage}
          aria-label="Print"
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border border-border bg-surface-2 text-foreground transition-colors hover:bg-secondary"
        >
          <Printer className="h-3.5 w-3.5" aria-hidden />
        </button>
        <button
          type="button"
          onClick={copyShare}
          disabled={sharing}
          aria-label="Copy share link"
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-full border border-border bg-surface-2 text-foreground transition-colors hover:bg-secondary disabled:opacity-60"
        >
          <Share2 className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
    </div>
  )
}
