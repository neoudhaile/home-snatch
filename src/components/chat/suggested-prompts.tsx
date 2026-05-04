'use client'

import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils'

const PROMPTS = [
  'Show me the top 5 listings under $3,500.',
  "Compare the apartments I've saved.",
  "What's overpriced in Williamsburg this week?",
  'Draft an email to a broker for the highest-scored listing.',
] as const

export function SuggestedPrompts({
  onPick,
  className,
}: {
  onPick: (text: string) => void
  className?: string
}) {
  return (
    <div className={cn('grid gap-2 sm:grid-cols-2', className)}>
      {PROMPTS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPick(p)}
          className={cn(
            'group inline-flex cursor-pointer items-center justify-between gap-3 rounded-2xl',
            'border border-border bg-card px-4 py-3 text-left text-[13.5px] leading-snug text-card-foreground',
            'transition-[border-color,background-color,transform] duration-200',
            'hover:border-foreground/20 hover:bg-surface-2 active:scale-[0.99]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          <span className="min-w-0">{p}</span>
          <ArrowRight
            aria-hidden
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-foreground"
          />
        </button>
      ))}
    </div>
  )
}
