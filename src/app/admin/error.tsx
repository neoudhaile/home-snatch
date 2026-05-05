'use client'

/**
 * Route-level error boundary for /admin. Catches any unhandled error from a
 * Server Component child that wasn't already wrapped in a per-panel try/catch.
 * Production used to 500 here; now we render a recoverable card with a Reset
 * button so the admin can retry without losing the URL.
 */

import { useEffect } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error('[admin] route error boundary:', error)
  }, [error])

  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto w-full max-w-[800px] px-4 py-12 sm:px-6 lg:px-8">
        <div className="rounded-2xl border border-border bg-card px-6 py-6 ring-1 ring-foreground/5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-4 w-4 shrink-0 text-warm-fg" />
            <div className="min-w-0">
              <h1 className="serif text-[24px] italic leading-tight tracking-tight text-foreground">
                /admin failed to render
              </h1>
              <p className="mt-2 text-[13px] text-muted-foreground">
                One of the dashboard data fetches threw and made it past the
                per-panel error guards. Click reset to retry. Check the
                deployment logs for the underlying SQL or LLM error.
              </p>
              {error.message ? (
                <pre className="mt-3 overflow-x-auto rounded-md border border-border bg-background/60 px-3 py-2 text-[12px] leading-snug text-muted-foreground">
                  {error.message}
                </pre>
              ) : null}
              {error.digest ? (
                <div className="mt-2 text-[11px] uppercase tracking-wider text-muted-foreground">
                  digest {error.digest}
                </div>
              ) : null}
              <button
                type="button"
                onClick={reset}
                className="mt-4 inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-surface-2 px-3 text-[12px] font-medium text-foreground transition-colors hover:bg-secondary"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Reset
              </button>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
