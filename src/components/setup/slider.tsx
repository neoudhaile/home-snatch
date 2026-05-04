'use client'

import { cn } from '@/lib/utils'

/**
 * Range slider with a track gradient cued by value.
 * Native input keeps a11y for free; we paint the track via gradient.
 */
export function Slider({
  value,
  onChange,
  min = 0,
  max = 10,
  step = 1,
  label,
  hint,
  unit,
  className,
}: {
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  label?: string
  hint?: string
  unit?: string
  className?: string
}) {
  const pct = ((value - min) / (max - min)) * 100

  return (
    <div className={cn('space-y-2', className)}>
      {label ? (
        <div className="flex items-baseline justify-between gap-2">
          <div>
            <span className="text-[13px] font-medium text-foreground">{label}</span>
            {hint ? (
              <span className="ml-2 text-[11px] text-muted-foreground">{hint}</span>
            ) : null}
          </div>
          <span className="tabular text-[13px] font-semibold text-foreground">
            {value}
            {unit ? <span className="ml-0.5 text-muted-foreground">{unit}</span> : null}
          </span>
        </div>
      ) : null}
      <div className="relative h-6">
        <div
          aria-hidden
          className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-secondary"
        />
        <div
          aria-hidden
          className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-foreground transition-[width] duration-200"
          style={{ width: `${pct}%` }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label ?? 'Value'}
          aria-valuetext={unit ? `${value}${unit}` : String(value)}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 h-6 w-full cursor-grab appearance-none bg-transparent active:cursor-grabbing
            [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:border-2
            [&::-webkit-slider-thumb]:border-foreground
            [&::-webkit-slider-thumb]:bg-background
            [&::-webkit-slider-thumb]:shadow-[0_2px_6px_-1px_oklch(0.2_0.04_220/0.35)]
            [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5
            [&::-moz-range-thumb]:rounded-full
            [&::-moz-range-thumb]:border-2
            [&::-moz-range-thumb]:border-foreground
            [&::-moz-range-thumb]:bg-background
            focus-visible:outline-none"
        />
      </div>
    </div>
  )
}
