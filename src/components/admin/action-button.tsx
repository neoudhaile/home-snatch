'use client'

import { useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type AdminAction = 'dedupe' | 'scrape' | 'refresh' | 'rescore' | 'recompute-vibes'

/**
 * Single action button. POSTs to `/api/admin/dq` with the chosen `action`,
 * shows a sonner toast with the result. While in flight, renders a spinner
 * inline; while waiting, renders the children.
 *
 * Optional flags:
 *   - `force`: passed through as `{ force: true }` in the POST body. Today
 *     only the rescore action consumes it (bypass the per-hash skip cache).
 *   - `confirm`: copy for window.confirm() before firing. Use for any
 *     destructive or expensive action — Force rescore costs LLM tokens.
 */
export function ActionButton({
  action,
  children,
  description,
  variant = 'outline',
  className,
  force,
  confirm,
}: {
  action: AdminAction
  children: React.ReactNode
  description?: string
  variant?: 'default' | 'outline' | 'secondary' | 'ghost'
  className?: string
  force?: boolean
  confirm?: string
}) {
  const [pending, startTransition] = useTransition()
  const [busy, setBusy] = useState(false)

  const onClick = () => {
    if (busy || pending) return
    if (confirm && typeof window !== 'undefined') {
      const ok = window.confirm(confirm)
      if (!ok) return
    }
    setBusy(true)
    const t = toast.loading(`${labelFor(action, force)} running…`, {
      description,
    })
    startTransition(async () => {
      try {
        const adminPass =
          typeof window !== 'undefined'
            ? window.localStorage.getItem('homesnatch:admin-pass')
            : null
        const res = await fetch('/api/admin/dq', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(adminPass ? { 'x-admin-pass': adminPass } : {}),
          },
          body: JSON.stringify(force ? { action, force: true } : { action }),
        })
        const json = (await res.json()) as Record<string, unknown>
        if (!res.ok) {
          toast.error(`${labelFor(action, force)} failed`, {
            id: t,
            description:
              (json.message as string) ||
              (json.error as string) ||
              `HTTP ${res.status}`,
          })
        } else {
          toast.success(`${labelFor(action, force)} done`, {
            id: t,
            description: summarizeResult(action, json),
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'unknown error'
        toast.error(`${labelFor(action, force)} failed`, {
          id: t,
          description: msg,
        })
      } finally {
        setBusy(false)
      }
    })
  }

  const isWorking = busy || pending
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={onClick}
      disabled={isWorking}
      className={cn('cursor-pointer', className)}
    >
      {isWorking ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : null}
      {children}
    </Button>
  )
}

function labelFor(a: AdminAction, force?: boolean): string {
  switch (a) {
    case 'dedupe':
      return 'Dedupe'
    case 'scrape':
      return 'Scrape'
    case 'refresh':
      return 'Refresh'
    case 'rescore':
      return force ? 'Force rescore' : 'Rescore'
    case 'recompute-vibes':
      return 'Vibes'
  }
}

function summarizeResult(action: AdminAction, j: Record<string, unknown>): string {
  switch (action) {
    case 'dedupe':
      return `${j.canonicals ?? 0} clusters, ${j.deduped ?? 0} listings deactivated`
    case 'scrape':
      return `${j.ingested ?? 0} ingested, ${j.deactivated ?? 0} deactivated`
    case 'refresh':
      return `${j.checked ?? 0} checked, ${j.gone ?? 0} gone, ${j.refreshed ?? 0} refreshed`
    case 'rescore':
      return `${j.scored ?? 0} listings scored${j.forced ? ' (forced)' : ''}`
    case 'recompute-vibes':
      return 'neighborhood vibes table updated'
  }
}
