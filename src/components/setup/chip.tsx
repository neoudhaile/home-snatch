'use client'

import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Chip({
  active,
  onClick,
  children,
  size = 'md',
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  size?: 'sm' | 'md'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'inline-flex cursor-pointer items-center gap-1.5 rounded-full border font-medium transition-all duration-200 ease-out',
        size === 'sm' ? 'h-7 px-2.5 text-[12px]' : 'h-9 px-3.5 text-[13px]',
        active
          ? 'border-foreground bg-foreground text-background shadow-[0_2px_8px_-2px_oklch(0.2_0.04_220/0.35)]'
          : 'border-border bg-surface-2 text-foreground hover:border-foreground/30 hover:bg-secondary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <span>{children}</span>
      {active ? <Check className="h-3 w-3" /> : null}
    </button>
  )
}
