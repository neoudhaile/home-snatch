/**
 * Data quality metrics. Pure read-only DB aggregations consumed by the admin
 * dashboard. Every metric below is computed in a single SQL round-trip — we
 * do not load the full `listings` table into Node.
 *
 * If you add a metric, prefer one query per metric and use jsonb aggregates
 * (`json_object_agg`, `count(*) FILTER (WHERE …)`) to keep the network cost
 * low.
 */
import { sql } from 'drizzle-orm'
import { unstable_cache } from 'next/cache'
import { getDb } from '@/lib/db'
import { SOURCES, type Source } from '@/types'
import { countDuplicateClusters } from '@/lib/listing-dedupe'

// ---------- types ----------

export type SourceMetric = {
  active: number
  inactive: number
  last_24h: number
  last_7d: number
}

export type DqMetrics = {
  total_active: number
  total_inactive: number
  by_source: Record<Source, SourceMetric>
  coverage_gaps: {
    no_photos: number
    no_contact: number
    no_address: number
    no_posted_at: number
    no_lat_lng: number
  }
  freshness: {
    fresh: number // posted_at <= 14d
    stale: number // 14d < posted_at <= 30d
    old: number // posted_at > 30d
  }
  duplicate_clusters: number
  last_scrape_run: {
    at: Date
    ingested: number
    by_source: Partial<Record<Source, number>>
  } | null
  score_health: {
    total_scored: number
    avg_score: number
    median_score: number
    score_buckets: {
      '0-20': number
      '20-40': number
      '40-60': number
      '60-80': number
      '80-100': number
    }
  }
}

// ---------- helpers ----------

function emptySourceMetric(): SourceMetric {
  return { active: 0, inactive: 0, last_24h: 0, last_7d: 0 }
}

function emptyBySource(): Record<Source, SourceMetric> {
  const out: Record<string, SourceMetric> = {}
  for (const s of SOURCES) out[s] = emptySourceMetric()
  return out as Record<Source, SourceMetric>
}

// ---------- main entry ----------

/**
 * Compute every dashboard metric. Optimized to 3 round trips:
 *   1. one big CTE-based listings query: per-source counts + coverage gaps +
 *      freshness buckets + last_scrape MAX (combined into a single result set
 *      via UNION ALL of small grouped/aggregate queries — same data scan)
 *   2. one query for last-scrape per-source breakdown (depends on (1)'s
 *      max(fetched_at) result, so cannot fold into (1))
 *   3. one query for score_health
 *   plus duplicate_clusters from `countDuplicateClusters()` (1 query).
 *
 * Net: 4 round trips, was 7.
 *
 * Wrapped in `unstable_cache` (60s TTL, tag `dq`) — admin doesn't need
 * second-by-second freshness; `revalidateTag('dq')` on scrape complete keeps
 * the user-perceived snapshot tight.
 */
async function _computeDqMetrics(): Promise<DqMetrics> {
  const db = getDb()

  // ---------- 1. Combined listings stats (per-source + gaps + freshness + last-fetch) ----------
  type SourceRow = {
    kind: 'source'
    source: string
    active: string
    inactive: string
    last_24h: string
    last_7d: string
    no_photos: null
    no_contact: null
    no_address: null
    no_posted_at: null
    no_lat_lng: null
    fresh: null
    stale: null
    old: null
    last_at: null
  }
  type GapRow = {
    kind: 'gaps'
    source: null
    active: null
    inactive: null
    last_24h: null
    last_7d: null
    no_photos: string
    no_contact: string
    no_address: string
    no_posted_at: string
    no_lat_lng: string
    fresh: null
    stale: null
    old: null
    last_at: null
  }
  type FreshRow = {
    kind: 'fresh'
    source: null
    active: null
    inactive: null
    last_24h: null
    last_7d: null
    no_photos: null
    no_contact: null
    no_address: null
    no_posted_at: null
    no_lat_lng: null
    fresh: string
    stale: string
    old: string
    last_at: null
  }
  type LastRow = {
    kind: 'last'
    source: null
    active: null
    inactive: null
    last_24h: null
    last_7d: null
    no_photos: null
    no_contact: null
    no_address: null
    no_posted_at: null
    no_lat_lng: null
    fresh: null
    stale: null
    old: null
    last_at: string | null
  }
  type CombinedRow = SourceRow | GapRow | FreshRow | LastRow

  const combined = (await db.execute<CombinedRow>(sql`
    SELECT 'source'::text AS kind, source, NULL::text AS active, NULL::text AS inactive,
           NULL::text AS last_24h, NULL::text AS last_7d,
           NULL::text AS no_photos, NULL::text AS no_contact, NULL::text AS no_address,
           NULL::text AS no_posted_at, NULL::text AS no_lat_lng,
           NULL::text AS fresh, NULL::text AS stale, NULL::text AS old,
           NULL::text AS last_at
      FROM (SELECT 1) _ WHERE false
    UNION ALL
    SELECT 'source'::text, source,
           COUNT(*) FILTER (WHERE is_active = true)::text,
           COUNT(*) FILTER (WHERE is_active = false)::text,
           COUNT(*) FILTER (WHERE fetched_at > now() - interval '24 hours')::text,
           COUNT(*) FILTER (WHERE fetched_at > now() - interval '7 days')::text,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           NULL
      FROM listings
      GROUP BY source
    UNION ALL
    SELECT 'gaps'::text, NULL, NULL, NULL, NULL, NULL,
           COUNT(*) FILTER (WHERE photos = '[]'::jsonb OR jsonb_array_length(coalesce(photos, '[]'::jsonb)) = 0)::text,
           COUNT(*) FILTER (WHERE contact IS NULL OR contact = '{}'::jsonb)::text,
           COUNT(*) FILTER (WHERE address IS NULL OR address = '')::text,
           COUNT(*) FILTER (WHERE posted_at IS NULL)::text,
           COUNT(*) FILTER (WHERE lat IS NULL OR lng IS NULL)::text,
           NULL, NULL, NULL,
           NULL
      FROM listings
      WHERE is_active = true
    UNION ALL
    SELECT 'fresh'::text, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL,
           COUNT(*) FILTER (WHERE posted_at > now() - interval '14 days')::text,
           COUNT(*) FILTER (WHERE posted_at <= now() - interval '14 days' AND posted_at > now() - interval '30 days')::text,
           COUNT(*) FILTER (WHERE posted_at <= now() - interval '30 days')::text,
           NULL
      FROM listings
      WHERE is_active = true AND posted_at IS NOT NULL
    UNION ALL
    SELECT 'last'::text, NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL, NULL, NULL,
           NULL, NULL, NULL,
           MAX(fetched_at)::text
      FROM listings
  `)) as unknown as CombinedRow[]

  const by_source = emptyBySource()
  let total_active = 0
  let total_inactive = 0
  let coverage_gaps = {
    no_photos: 0,
    no_contact: 0,
    no_address: 0,
    no_posted_at: 0,
    no_lat_lng: 0,
  }
  let freshness = { fresh: 0, stale: 0, old: 0 }
  let lastAtRaw: string | null = null

  for (const r of combined) {
    if (r.kind === 'source') {
      const src = r.source as Source
      if (!SOURCES.includes(src)) continue
      by_source[src] = {
        active: Number(r.active),
        inactive: Number(r.inactive),
        last_24h: Number(r.last_24h),
        last_7d: Number(r.last_7d),
      }
      total_active += Number(r.active)
      total_inactive += Number(r.inactive)
    } else if (r.kind === 'gaps') {
      coverage_gaps = {
        no_photos: Number(r.no_photos ?? 0),
        no_contact: Number(r.no_contact ?? 0),
        no_address: Number(r.no_address ?? 0),
        no_posted_at: Number(r.no_posted_at ?? 0),
        no_lat_lng: Number(r.no_lat_lng ?? 0),
      }
    } else if (r.kind === 'fresh') {
      freshness = {
        fresh: Number(r.fresh ?? 0),
        stale: Number(r.stale ?? 0),
        old: Number(r.old ?? 0),
      }
    } else if (r.kind === 'last') {
      lastAtRaw = r.last_at
    }
  }

  // ---------- 2. duplicate clusters + last-scrape per-source + score_health (parallel) ----------
  const duplicateClustersP = countDuplicateClusters()

  const lastScrapeP: Promise<DqMetrics['last_scrape_run']> = lastAtRaw
    ? (async () => {
        const at = new Date(lastAtRaw!)
        const runRows = (await db.execute<{ source: string; n: string }>(sql`
          SELECT source, COUNT(*)::text AS n
          FROM listings
          WHERE fetched_at >= ${at.toISOString()}::timestamptz - interval '60 seconds'
            AND fetched_at <= ${at.toISOString()}::timestamptz + interval '60 seconds'
          GROUP BY source
        `)) as unknown as Array<{ source: string; n: string }>
        const bs: Partial<Record<Source, number>> = {}
        let ingested = 0
        for (const r of runRows) {
          bs[r.source as Source] = Number(r.n)
          ingested += Number(r.n)
        }
        return { at, ingested, by_source: bs }
      })()
    : Promise.resolve(null)

  const scoreHealthP = (async () => {
    const [scoreAgg] = (await db.execute<{
      total: string
      avg: string | null
      median: string | null
      b1: string
      b2: string
      b3: string
      b4: string
      b5: string
    }>(sql`
      SELECT
        COUNT(*)::text AS total,
        AVG(score)::text AS avg,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY score))::text AS median,
        COUNT(*) FILTER (WHERE score >= 0  AND score < 20 )::text AS b1,
        COUNT(*) FILTER (WHERE score >= 20 AND score < 40 )::text AS b2,
        COUNT(*) FILTER (WHERE score >= 40 AND score < 60 )::text AS b3,
        COUNT(*) FILTER (WHERE score >= 60 AND score < 80 )::text AS b4,
        COUNT(*) FILTER (WHERE score >= 80 AND score <= 100)::text AS b5
      FROM scores
    `)) as unknown as Array<{
      total: string
      avg: string | null
      median: string | null
      b1: string
      b2: string
      b3: string
      b4: string
      b5: string
    }>
    return {
      total_scored: Number(scoreAgg?.total ?? 0),
      avg_score: scoreAgg?.avg ? Number(Number(scoreAgg.avg).toFixed(1)) : 0,
      median_score: scoreAgg?.median ? Number(Number(scoreAgg.median).toFixed(1)) : 0,
      score_buckets: {
        '0-20': Number(scoreAgg?.b1 ?? 0),
        '20-40': Number(scoreAgg?.b2 ?? 0),
        '40-60': Number(scoreAgg?.b3 ?? 0),
        '60-80': Number(scoreAgg?.b4 ?? 0),
        '80-100': Number(scoreAgg?.b5 ?? 0),
      },
    }
  })()

  const [duplicate_clusters, last_scrape_run, score_health] = await Promise.all([
    duplicateClustersP,
    lastScrapeP,
    scoreHealthP,
  ])

  return {
    total_active,
    total_inactive,
    by_source,
    coverage_gaps,
    freshness,
    duplicate_clusters,
    last_scrape_run,
    score_health,
  }
}

/**
 * 60-second cached wrapper. Tagged `dq`; invalidate via `revalidateTag('dq')`
 * after a scrape/refresh/rescore so the dashboard reflects fresh state without
 * waiting for the TTL.
 */
export const getDqMetrics = unstable_cache(_computeDqMetrics, ['dq-metrics-v1'], {
  revalidate: 60,
  tags: ['dq'],
})
