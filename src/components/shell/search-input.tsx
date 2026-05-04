'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useRouter } from 'next/navigation'
import { LoaderCircle, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'

const RECENT_KEY = 'homesnatch:recent-searches'
const RECENT_MAX = 5

function readRecent(): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(RECENT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, RECENT_MAX)
  } catch {
    return []
  }
}

function pushRecent(q: string) {
  if (typeof window === 'undefined') return
  const trimmed = q.trim()
  if (!trimmed) return
  try {
    const existing = readRecent().filter((r) => r.toLowerCase() !== trimmed.toLowerCase())
    const next = [trimmed, ...existing].slice(0, RECENT_MAX)
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    // ignore
  }
}

/**
 * Center-of-header search input. Submits to `/?q=<query>`. Reads `?q=` on
 * mount to seed the input with whatever's in the URL. Cmd/Ctrl+K focuses,
 * Esc clears.
 */
export function SearchInput({
  className,
  loading: loadingProp,
  initialQuery,
}: {
  className?: string
  /** Override loading state (e.g. when an in-flight server call is being awaited). */
  loading?: boolean
  /** Seed value (typically the URL `?q=` param). */
  initialQuery?: string
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState(initialQuery ?? '')
  const [open, setOpen] = useState(false)
  const [recent, setRecent] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)

  // Re-seed when the parent's `initialQuery` changes (e.g. server re-render
  // after navigation). Also clears the in-flight indicator.
  useEffect(() => {
    setValue(initialQuery ?? '')
    setSubmitting(false)
  }, [initialQuery])

  // Hydrate recent searches once on the client.
  useEffect(() => {
    setRecent(readRecent())
  }, [])

  const submit = useCallback(
    (raw: string) => {
      const q = raw.trim()
      if (!q) {
        // Empty submit → drop the param.
        router.push('/')
        setOpen(false)
        return
      }
      pushRecent(q)
      setRecent(readRecent())
      setSubmitting(true)
      const params = new URLSearchParams()
      params.set('q', q)
      router.push(`/?${params.toString()}`)
      setOpen(false)
      // Blur so the dropdown stays closed after navigation.
      inputRef.current?.blur()
    },
    [router]
  )

  // Cmd+K / Ctrl+K → focus
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isMac = navigator.platform.toLowerCase().includes('mac')
      const trigger = isMac ? e.metaKey : e.ctrlKey
      if (trigger && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Click-away to close the dropdown
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) {
      document.addEventListener('mousedown', onClick)
      return () => document.removeEventListener('mousedown', onClick)
    }
  }, [open])

  function clear() {
    setValue('')
    // If we were displaying a server-seeded query, clearing should also drop
    // it from the URL so the feed un-filters.
    if (initialQuery && initialQuery.trim().length > 0) {
      router.push('/')
    }
    inputRef.current?.focus()
  }

  const showRecent = open && recent.length > 0 && value.trim().length === 0
  const isLoading = loadingProp || submitting
  const isMacShortcut = useMemo(() => {
    if (typeof navigator === 'undefined') return false
    return navigator.platform.toLowerCase().includes('mac')
  }, [])

  return (
    <div ref={containerRef} className={cn('relative w-full', className)}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit(value)
        }}
        className="relative"
      >
        <div
          aria-hidden
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
        >
          {isLoading ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Search className="h-3.5 w-3.5" />
          )}
        </div>
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              if (value.trim().length > 0) {
                e.preventDefault()
                clear()
              } else {
                setOpen(false)
                inputRef.current?.blur()
              }
            }
          }}
          placeholder="Try: 1br under $3k in Brooklyn near a coffee shop"
          aria-label="Search listings"
          className={cn(
            'tabular h-8 w-full rounded-full border border-border bg-surface-2 pl-8 pr-16 text-[13px]',
            'placeholder:text-muted-foreground',
            'transition-colors hover:bg-secondary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background'
          )}
        />
        {value.length > 0 ? (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
          >
            <X className="h-3 w-3" aria-hidden />
          </button>
        ) : (
          <span
            aria-hidden
            className="tabular pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 select-none items-center gap-0.5 rounded-md border border-border bg-background px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground sm:inline-flex"
          >
            {isMacShortcut ? '⌘K' : 'Ctrl K'}
          </span>
        )}
      </form>

      {showRecent ? (
        <div className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 overflow-hidden rounded-lg border border-border bg-popover p-1 shadow-md">
          <div className="px-2 py-1 text-[11px] uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
          {recent.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => {
                setValue(r)
                submit(r)
              }}
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-secondary"
            >
              <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
              <span className="truncate">{r}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
