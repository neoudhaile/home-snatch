/**
 * Admin / data-quality dashboard.
 *
 * This is the layer that makes the user trust the feed. It exposes scrape
 * health by source, coverage gaps over the active set, freshness distribution,
 * duplicate-cluster count, and score distribution. Action buttons in the top
 * bar trigger the maintenance jobs (`/api/admin/dq`).
 *
 * Auth: `x-admin-pass` header against `ADMIN_PASS`. The action buttons read it
 * from `localStorage` (key `homesnatch:admin-pass`). For v0 we mostly rely on
 * the obscure URL.
 *  TODO(phase 2): real session auth so this can survive being public-Vercel.
 */
import { Suspense } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { ActionButton } from '@/components/admin/action-button'
import { CoverageBars, FreshnessBar } from '@/components/admin/coverage-bars'
import { DqCard } from '@/components/admin/dq-card'
import {
  InsightsAnomalies,
  InsightsAnomaliesSkeleton,
} from '@/components/admin/insights-anomalies'
import { InsightsCleanup } from '@/components/admin/insights-cleanup'
import {
  InsightsMarketSummary,
  InsightsMarketSummarySkeleton,
} from '@/components/admin/insights-market-summary'
import { ScoreHistogram } from '@/components/admin/score-histogram'
import { SourceTable } from '@/components/admin/source-table'
import { Skeleton } from '@/components/ui/skeleton'
import { getDqMetrics } from '@/lib/data-quality'
import { SOURCES } from '@/types'

export const dynamic = 'force-dynamic'

export default function AdminPage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto w-full max-w-[1200px] px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="serif text-[40px] italic leading-tight tracking-tight text-foreground">
              data quality
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              scrape health, coverage gaps, dedupe state, score distribution.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ActionButton action="scrape" description="Run all source scrapers and upsert.">
              Run scrape now
            </ActionButton>
            <ActionButton action="refresh" description="Re-fetch listings older than 24h.">
              Refresh stale
            </ActionButton>
            <ActionButton action="dedupe" description="Mark cross-site duplicates inactive.">
              Dedupe now
            </ActionButton>
            <ActionButton action="rescore" description="Score listings missing a current rationale.">
              Rescore
            </ActionButton>
            <ActionButton
              action="rescore"
              variant="secondary"
              force
              description="Re-score every active listing, ignoring the per-hash cache. Costs LLM tokens."
              confirm="Force rescore every active listing? This re-runs Sonnet 4.6 on the full set and burns tokens — only do it if a profile change isn't reflected in the feed."
            >
              Force rescore
            </ActionButton>
            <ActionButton action="recompute-vibes" description="Recompute NTA vibe scores.">
              Recompute vibes
            </ActionButton>
          </div>
        </header>

        {/* AI Insights — additive section; existing DQ widgets remain below. */}
        <section className="mb-8 space-y-4">
          <div className="flex items-baseline justify-between">
            <h2 className="serif text-[22px] italic leading-tight tracking-tight text-foreground">
              ai insights
            </h2>
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
              market, anomalies, cleanup
            </span>
          </div>

          <Suspense fallback={<InsightsMarketSummarySkeleton />}>
            <InsightsMarketSummary />
          </Suspense>

          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Suspense fallback={<InsightsAnomaliesSkeleton />}>
              <InsightsAnomalies />
            </Suspense>
            <InsightsCleanup />
          </div>
        </section>

        <Suspense fallback={<DashboardSkeleton />}>
          <Dashboard />
        </Suspense>

        <section className="mt-8 rounded-xl border border-border bg-card px-4 py-4 ring-1 ring-foreground/5">
          <h3 className="text-[13px] font-medium text-foreground">Recent admin log</h3>
          <p className="mt-1 text-[12px] text-muted-foreground">
            no log yet, will be added in Phase 2.
          </p>
        </section>
      </main>
    </div>
  )
}

async function Dashboard() {
  const m = await getDqMetrics()
  const sourcesActive = (Object.keys(m.by_source) as Array<keyof typeof m.by_source>).filter(
    (s) => m.by_source[s].active > 0
  ).length
  const lastScrape = m.last_scrape_run
    ? `${formatDistanceToNow(m.last_scrape_run.at)} ago, ${m.last_scrape_run.ingested} rows`
    : 'never'

  return (
    <div className="space-y-6">
      {/* Hero strip */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <DqCard
          label="active listings"
          value={m.total_active.toLocaleString('en-US')}
          sub={`${m.total_inactive.toLocaleString('en-US')} inactive`}
        />
        <DqCard
          label="sources tracked"
          value={`${sourcesActive} / ${SOURCES.length}`}
          sub={`${m.duplicate_clusters} duplicate clusters`}
        />
        <DqCard label="last scrape" value={lastScrape.split(',')[0]} sub={lastScrape} />
      </div>

      {/* By-source + coverage */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_3fr]">
        <SourceTable bySource={m.by_source} />
        <CoverageBars totalActive={m.total_active} gaps={m.coverage_gaps} />
      </div>

      {/* Freshness + score histogram */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <FreshnessBar freshness={m.freshness} />
        <ScoreHistogram health={m.score_health} />
      </div>
    </div>
  )
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Skeleton className="h-[96px]" />
        <Skeleton className="h-[96px]" />
        <Skeleton className="h-[96px]" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[2fr_3fr]">
        <Skeleton className="h-[280px]" />
        <Skeleton className="h-[280px]" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-[180px]" />
        <Skeleton className="h-[220px]" />
      </div>
    </div>
  )
}
