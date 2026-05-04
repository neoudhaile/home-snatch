'use client'

import { Check, ChevronDown } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Source } from '@/types'
import { SOURCES } from '@/types'
import { formatSource } from '@/lib/format'

export function SourceFilter({
  value,
  onChange,
}: {
  value: Source[]
  onChange: (v: Source[]) => void
}) {
  const allActive = value.length === 0
  const label = allActive
    ? 'All sources'
    : value.length === 1
      ? formatSource(value[0])
      : `${value.length} sources`

  function toggle(s: Source) {
    if (value.includes(s)) onChange(value.filter((x) => x !== s))
    else onChange([...value, s])
  }

  function clearAll() {
    onChange([])
  }

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          'tabular inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground',
          'transition-colors hover:bg-secondary',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        )}
        aria-label="Filter by source"
      >
        <span>{label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-1">
        <button
          onClick={clearAll}
          className={cn(
            'flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px]',
            'hover:bg-secondary',
            allActive && 'font-medium',
          )}
        >
          <span>All sources</span>
          {allActive && <Check className="h-3.5 w-3.5" aria-hidden />}
        </button>
        <div className="my-1 h-px bg-border" />
        {SOURCES.map((s) => {
          const active = value.includes(s)
          return (
            <button
              key={s}
              onClick={() => toggle(s)}
              className={cn(
                'flex w-full cursor-pointer items-center justify-between rounded-md px-2.5 py-1.5 text-[13px]',
                'hover:bg-secondary',
                active && 'font-medium',
              )}
            >
              <span>{formatSource(s)}</span>
              {active && <Check className="h-3.5 w-3.5" aria-hidden />}
            </button>
          )
        })}
      </PopoverContent>
    </Popover>
  )
}
