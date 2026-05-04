import { cn } from '@/lib/utils'

/**
 * Score badge. The outer surface uses a subtle warm-to-cool gradient per
 * `score-surface` in globals.css; the number on top is solid text (no
 * gradient text per impeccable absolute ban). Color carries meaning,
 * but the number itself is also visible without color cues.
 */
export function ScoreBadge({
  score,
  size = 'md',
  className,
}: {
  score: number
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  const sizing = {
    sm: 'h-7 w-7 text-[11px]',
    md: 'h-9 w-9 text-[13px]',
    lg: 'h-12 w-12 text-[16px]',
    xl: 'h-16 w-16 text-[22px]',
  }[size]

  return (
    <div
      className={cn(
        'score-surface relative inline-flex items-center justify-center rounded-full font-semibold',
        'shadow-[0_2px_10px_-2px_oklch(0.15_0.014_220/0.45),inset_0_1px_0_oklch(1_0_0/0.35)]',
        'ring-1 ring-inset ring-foreground/10',
        sizing,
        className,
      )}
      aria-label={`Match score ${score} of 100`}
    >
      <span
        className="tabular tracking-tight"
        style={{ color: 'oklch(0.18 0.04 220)' }}
      >
        {score}
      </span>
    </div>
  )
}
