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
 * Compute every dashboard metric. Roughly six SQL queries, each indexed
 * (is_active, posted_at, fetched_at) — runs in low ms even on tens of
 * thousands of rows.
 */
export async function getDqMetrics(): Promise<DqMetrics> {
  const db = getDb()

  // 1. Per-source counts: active / inactive / fetched in last 24h, 7d.
  const sourceRows = (await db.execute<{
    source: string
    active: string
    inactive: string
    last_24h: string
    last_7d: string
  }>(sql`
    SELECT
      source,
      COUNT(*) FILTER (WHERE is_active = true)::text AS active,
      COUNT(*) FILTER (WHERE is_active = false)::text AS inactive,
      COUNT(*) FILTER (WHERE fetched_at > now() - interval '24 hours')::text AS last_24h,
      COUNT(*) FILTER (WHERE fetched_at > now() - interval '7 days')::text AS last_7d
    FROM listings
    GROUP BY source
  `)) as unknown as Array<{
    source: string
    active: string
    inactive: string
    last_24h: string
    last_7d: string
  }>

  const by_source = emptyBySource()
  let total_active = 0
  let total_inactive = 0
  for (const r of sourceRows) {
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
  }

  // 2. Coverage gaps. Only count gaps over ACTIVE listings — inactive ones are
  // already filtered out of the feed and their gaps don't affect the user.
  const [gaps] = (await db.execute<{
    no_photos: string
    no_contact: string
    no_address: string
    no_posted_at: string
    no_lat_lng: string
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE photos = '[]'::jsonb OR jsonb_array_length(coalesce(photos, '[]'::jsonb)) = 0)::text AS no_photos,
      COUNT(*) FILTER (WHERE contact IS NULL OR contact = '{}'::jsonb)::text AS no_contact,
      COUNT(*) FILTER (WHERE address IS NULL OR address = '')::text AS no_address,
      COUNT(*) FILTER (WHERE posted_at IS NULL)::text AS no_posted_at,
      COUNT(*) FILTER (WHERE lat IS NULL OR lng IS NULL)::text AS no_lat_lng
    FROM listings
    WHERE is_active = true
  `)) as unknown as Array<{
    no_photos: string
    no_contact: string
    no_address: string
    no_posted_at: string
    no_lat_lng: string
  }>
  const coverage_gaps = {
    no_photos: Number(gaps?.no_photos ?? 0),
    no_contact: Number(gaps?.no_contact ?? 0),
    no_address: Number(gaps?.no_address ?? 0),
    no_posted_at: Number(gaps?.no_posted_at ?? 0),
    no_lat_lng: Number(gaps?.no_lat_lng ?? 0),
  }

  // 3. Freshness buckets over active listings with a known `posted_at`.
  const [fresh] = (await db.execute<{
    fresh: string
    stale: string
    old: string
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE posted_at > now() - interval '14 days')::text AS fresh,
      COUNT(*) FILTER (WHERE posted_at <= now() - interval '14 days' AND posted_at > now() - interval '30 days')::text AS stale,
      COUNT(*) FILTER (WHERE posted_at <= now() - interval '30 days')::text AS old
    FROM listings
    WHERE is_active = true AND posted_at IS NOT NULL
  `)) as unknown as Array<{ fresh: string; stale: string; old: string }>
  const freshness = {
    fresh: Number(fresh?.fresh ?? 0),
    stale: Number(fresh?.stale ?? 0),
    old: Number(fresh?.old ?? 0),
  }

  // 4. Duplicate clusters.
  const duplicate_clusters = await countDuplicateClusters()

  // 5. Last scrape run: most recent `fetched_at` and a per-source count of
  // rows ingested in the same minute as that timestamp. Imperfect but works
  // without an `admin_log` table.
  const [last] = (await db.execute<{ at: string | null }>(sql`
    SELECT MAX(fetched_at)::text AS at FROM listings
  `)) as unknown as Array<{ at: string | null }>
  let last_scrape_run: DqMetrics['last_scrape_run'] = null
  if (last?.at) {
    const at = new Date(last.at)
    const runRows = (await db.execute<{
      source: string
      n: string
    }>(sql`
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
    last_scrape_run = { at, ingested, by_source: bs }
  }

  // 6. Score health: distribution + avg/median.
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

  const score_health = {
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
