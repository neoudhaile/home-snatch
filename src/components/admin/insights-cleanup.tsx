/**
 * Cleanup suggestions panel. Server Component shell that renders the list,
 * with a Client Component (`CleanupRow`) wrapping each row's Apply / Dismiss
 * buttons.
 *
 * Apply POSTs to `/api/admin/insights` with `{action:'apply-cleanup', listing_id, action_type}`.
 * On success, the row is removed optimistically with a sonner toast.
 *
 * The admin must click before any deactivation; we never auto-execute.
 */
'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, Trash2, Archive, AlertCircle, ExternalLink } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { CleanupAction, CleanupSuggestion } from '@/lib/insights'
import { cn } from '@/lib/utils'

const ACTION_LABEL: Record<CleanupAction, string> = {
  deactivate: 'deactivate',
  delete: 'delete',
  'mark-low-quality': 'low quality',
}

const ACTION_TONE: Record<CleanupAction, string> = {
  deactivate: 'text-warm-fg',
  delete: 'text-destructive',
  'mark-low-quality': 'text-muted-foreground',
}

const ACTION_ICON: Record<CleanupAction, React.ComponentType<{ className?: string }>> = {
  deactivate: Archive,
  delete: Trash2,
  'mark-low-quality': AlertCircle,
}

/**
 * Load + render. Fetches client-side because the panel needs a client
 * boundary anyway (Apply / Dismiss are interactive). Also dodges a long
 * server render if the LLM is slow on the cleanup batch.
 */
export function InsightsCleanup() {
  const [items, setItems] = useState<CleanupSuggestion[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const adminPass =
      typeof window !== 'undefined'
        ? window.localStorage.getItem('homesnatch:admin-pass')
        : null
    fetch('/api/admin/insights?type=cleanup', {
      headers: adminPass ? { 'x-admin-pass': adminPass } : undefined,
    })
      .then(async (res) => {
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as Record<string, unknown>
          throw new Error((j.message as string) || `HTTP ${res.status}`)
        }
        return (await res.json()) as CleanupSuggestion[]
      })
      .then((data) => {
        if (!cancelled) setItems(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'failed to load')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismiss = (listing_id: string) => {
    setItems((prev) => (prev ? prev.filter((s) => s.listing_id !== listing_id) : prev))
  }

  return (
    <div className="rounded-xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="flex items-baseline justify-between border-b border-border px-4 py-3">
        <h3 className="text-[13px] font-medium text-foreground">Cleanup suggestions</h3>
        <span className="tabular text-[11px] text-muted-foreground">
          {items == null
            ? 'loading'
            : items.length === 0
              ? 'nothing to clean'
              : `${items.length} candidates`}
        </span>
      </div>

      {error ? (
        <div className="px-4 py-6 text-[13px] text-destructive">{error}</div>
      ) : items == null ? (
        <div className="space-y-2 px-4 py-3">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-10 text-center">
          <div className="text-[13px] text-foreground">No cleanup needed.</div>
          <div className="mt-1 text-[12px] text-muted-foreground">
            Active listings look healthy.
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {items.map((s) => (
            <CleanupRow key={s.listing_id} suggestion={s} onDismiss={dismiss} />
          ))}
        </ul>
      )}
    </div>
  )
}

function CleanupRow({
  suggestion,
  onDismiss,
}: {
  suggestion: CleanupSuggestion
  onDismiss: (listing_id: string) => void
}) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)
  const tone = ACTION_TONE[suggestion.action]
  const Icon = ACTION_ICON[suggestion.action]

  const apply = (actionType: 'deactivate' | 'delete') => {
    if (busy || pending) return
    setBusy(true)
    const t = toast.loading(`${actionType === 'delete' ? 'Deleting' : 'Deactivating'} listing`)
    startTransition(async () => {
      try {
        const adminPass =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('homesnatch:admin-pass')
            : null
        const res = await fetch('/api/admin/insights', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(adminPass ? { 'x-admin-pass': adminPass } : {}),
          },
          body: JSON.stringify({
            action: 'apply-cleanup',
            listing_id: suggestion.listing_id,
            action_type: actionType,
          }),
        })
        const json = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          toast.error('Apply failed', {
            id: t,
            description: (json.message as string) || `HTTP ${res.status}`,
          })
        } else {
          toast.success(`${actionType === 'delete' ? 'Deleted' : 'Deactivated'}`, {
            id: t,
            description: suggestion.listing_summary,
          })
          onDismiss(suggestion.listing_id)
        }
      } catch (err) {
        toast.error('Apply failed', {
          id: t,
          description: err instanceof Error ? err.message : 'unknown error',
        })
      } finally {
        setBusy(false)
      }
    })
  }

  // For 'mark-low-quality' the lightweight write is to deactivate; we don't
  // delete data, just hide it from the active feed.
  const primaryActionType: 'deactivate' | 'delete' =
    suggestion.action === 'delete' ? 'delete' : 'deactivate'

  const isWorking = busy || pending

  return (
    <li className="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 px-4 py-3">
      <Icon className={cn('h-3.5 w-3.5', tone)} aria-label={suggestion.action} />
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={cn('text-[11px] uppercase tracking-wider', tone)}>
            {ACTION_LABEL[suggestion.action]}
          </span>
          <a
            href={suggestion.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          >
            open
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
        <div className="mt-0.5 truncate text-[13px] text-foreground">{suggestion.reason}</div>
        <div className="tabular truncate text-[12px] text-muted-foreground">
          {suggestion.listing_summary}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="default"
          size="xs"
          disabled={isWorking}
          onClick={() => apply(primaryActionType)}
          className="cursor-pointer"
        >
          {isWorking ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Apply
        </Button>
        <Button
          variant="ghost"
          size="xs"
          disabled={isWorking}
          onClick={() => onDismiss(suggestion.listing_id)}
          className="cursor-pointer"
        >
          Dismiss
        </Button>
      </div>
    </li>
  )
}
