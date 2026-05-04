import { cn } from '@/lib/utils'

/**
 * Tightly-spaced metric card. Three-column hero strip uses these. Data-first:
 * label small + muted, value tabular and big, optional sub-line for context.
 */
export function DqCard({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: string
  sub?: string
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-card px-4 py-4 ring-1 ring-foreground/5',
        className
      )}
    >
      <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="tabular mt-1.5 text-[28px] font-medium leading-none text-foreground">
        {value}
      </div>
      {sub ? (
        <div className="tabular mt-2 text-[12px] text-muted-foreground">{sub}</div>
      ) : null}
    </div>
  )
}
