'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

export function Description({ text }: { text: string | null | undefined }) {
  const [open, setOpen] = useState(false)
  if (!text) return null

  return (
    <section className="space-y-2">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        From the listing
      </h3>
      <p
        className={cn(
          'whitespace-pre-line text-[14px] leading-relaxed text-foreground/90',
          !open && 'line-clamp-4',
        )}
      >
        {text}
      </p>
      <button
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer text-[12px] font-medium text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline"
      >
        {open ? 'Show less' : 'Show more'}
      </button>
    </section>
  )
}
