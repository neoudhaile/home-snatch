/**
 * Market summary hero card. Server Component calling `generateMarketSummary()`
 * directly. Renders the LLM-generated headline (large), three observations
 * (bullets), and one recommendation (callout). The deterministic stats block
 * is shown as a compact strip below so the user can verify against the LLM
 * prose.
 */
import { Sparkles, AlertTriangle } from 'lucide-react'
import { formatDistanceToNow } from 'date-fns'
import { generateMarketSummary } from '@/lib/insights'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Inline-error card shown when a single panel fails to load. */
function InsightsErrorCard({ label, message }: { label: string; message: string }) {
  return (
    <section className="rounded-2xl border border-border bg-card px-5 py-4 ring-1 ring-foreground/5">
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warm-fg" />
        <div className="min-w-0">
          <div className="text-[12px] font-medium text-foreground">
            {label} unavailable
          </div>
          <div className="mt-0.5 break-all text-[12px] text-muted-foreground">
            {message}
          </div>
        </div>
      </div>
    </section>
  )
}

export async function InsightsMarketSummary() {
  // Per-panel error containment: if generateMarketSummary throws, render a
  // small inline error card instead of letting the whole /admin page 500.
  // The function itself is supposed to fall back to deterministic copy on
  // any internal error, so reaching this catch is rare — but keep it as a
  // belt-and-suspenders guard.
  let m: Awaited<ReturnType<typeof generateMarketSummary>>
  try {
    m = await generateMarketSummary()
  } catch (err) {
    return (
      <InsightsErrorCard
        label="market summary"
        message={(err as Error).message ?? 'unknown error'}
      />
    )
  }
  const stats = m.raw_stats
  const topBoroughs = stats.by_borough.slice(0, 3)

  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border border-border bg-card ring-1 ring-foreground/5'
      )}
    >
      {/* Subtle gradient surface, background only, never on text. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            'radial-gradient(900px 360px at 12% -10%, var(--cool) 0%, transparent 60%), radial-gradient(700px 320px at 95% 10%, var(--warm) 0%, transparent 60%)',
        }}
      />

      <div className="relative px-5 py-5">
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-3.5 w-3.5 text-cool-fg" />
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              market summary, last {stats.window_days} days
            </span>
          </div>
          <span className="tabular text-[11px] text-muted-foreground">
            {m.llm_skipped ? 'deterministic fallback' : 'sonnet 4.6'}
            {' · '}
            {formatDistanceToNow(m.computed_at)} ago
          </span>
        </div>

        {/* Headline */}
        <h2 className="serif mt-3 text-[28px] italic leading-[1.15] tracking-tight text-foreground sm:text-[32px]">
          {m.headline}
        </h2>

        {/* Observations + recommendation */}
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
          <ul className="space-y-2.5">
            {m.three_observations.map((obs, i) => (
              <li key={i} className="flex items-start gap-2.5 text-[14px] text-foreground">
                <span className="tabular mt-1.5 shrink-0 text-[11px] text-muted-foreground">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="leading-snug">{obs}</span>
              </li>
            ))}
          </ul>

          <aside className="rounded-xl border border-border bg-background/60 px-4 py-3 ring-1 ring-foreground/5 backdrop-blur-sm">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
              this week
            </div>
            <p className="mt-1.5 text-[14px] leading-snug text-foreground">
              {m.one_recommendation}
            </p>
          </aside>
        </div>

        {/* Raw stats verification strip */}
        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-4 text-[12px] text-muted-foreground">
          <span>
            <span className="tabular text-foreground">{stats.total_listings.toLocaleString('en-US')}</span>
            {' listings'}
          </span>
          {topBoroughs.map((b) => (
            <span key={b.borough}>
              {b.borough}{' '}
              <span className="tabular text-foreground">
                {b.count.toLocaleString('en-US')}
              </span>
              {b.median != null ? (
                <>
                  {', med '}
                  <span className="tabular text-foreground">
                    ${b.median.toLocaleString('en-US')}
                  </span>
                </>
              ) : null}
            </span>
          ))}
          {stats.cheapest_under_3k.length > 0 ? (
            <span>
              <span className="tabular text-foreground">
                {stats.cheapest_under_3k.length}
              </span>
              {' under $3k'}
            </span>
          ) : null}
        </div>
      </div>
    </section>
  )
}

export function InsightsMarketSummarySkeleton() {
  return (
    <section className="rounded-2xl border border-border bg-card ring-1 ring-foreground/5">
      <div className="px-5 py-5">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="mt-3 h-9 w-full" />
        <Skeleton className="mt-2 h-9 w-3/4" />
        <div className="mt-5 grid grid-cols-1 gap-5 lg:grid-cols-[3fr_2fr]">
          <div className="space-y-2.5">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-[92%]" />
            <Skeleton className="h-4 w-[80%]" />
          </div>
          <Skeleton className="h-[88px] w-full" />
        </div>
        <Skeleton className="mt-5 h-3 w-2/3" />
      </div>
    </section>
  )
}
