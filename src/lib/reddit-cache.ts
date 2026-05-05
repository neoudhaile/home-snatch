/**
 * Reddit classification cache — DB-backed, keyed by Reddit post id.
 *
 * Why this exists: `reddit.ts` calls Haiku to classify every candidate post on
 * every cron run. Across runs, ~80% of /new posts repeat (Reddit /new is
 * sticky for hours). Re-classifying is wasted Anthropic spend and wall-time.
 *
 * Pipeline:
 *   1. `getCachedClassifications(ids)` — single SELECT, returns Map<id, cls>
 *      filtered to entries newer than TTL_MS.
 *   2. caller runs Haiku ONLY for the misses.
 *   3. `upsertClassifications(rows)` — single INSERT … ON CONFLICT for the
 *      newly-classified posts.
 *
 * TTL: 24h. Reddit posts evolve (edits, deletions), so we don't want to pin
 * a stale classification forever — but 24h is long enough to cover the next
 * cron pass for any post that's still alive.
 *
 * Failure mode: any DB error here is logged and swallowed — we degrade to
 * "no cache" rather than blocking the scraper. The classification still runs;
 * just no speedup.
 */

import { inArray, sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { reddit_classifications } from '@/db/schema'

const TTL_MS = 24 * 60 * 60 * 1000

/**
 * Fetch existing classifications for the given Reddit post ids. Stale entries
 * (older than TTL_MS) are filtered out — caller will treat them as misses and
 * the next upsert overwrites them.
 */
export async function getCachedClassifications<T = unknown>(
  postIds: string[],
): Promise<Map<string, T>> {
  const out = new Map<string, T>()
  if (postIds.length === 0) return out
  try {
    const db = getDb()
    const rows = await db
      .select({
        post_id: reddit_classifications.post_id,
        classification: reddit_classifications.classification,
        cached_at: reddit_classifications.cached_at,
      })
      .from(reddit_classifications)
      .where(inArray(reddit_classifications.post_id, postIds))

    const cutoff = Date.now() - TTL_MS
    for (const r of rows) {
      const ts = r.cached_at ? new Date(r.cached_at).getTime() : 0
      if (ts < cutoff) continue
      out.set(r.post_id, r.classification as T)
    }
  } catch (err) {
    console.warn('[reddit-cache] read failed:', (err as Error).message)
  }
  return out
}

/**
 * Upsert a batch of classifications. Single statement; safe to call with an
 * empty array (no-ops). `cached_at` is bumped to `now()` on conflict.
 */
export async function upsertClassifications(
  rows: Array<{ post_id: string; classification: unknown }>,
): Promise<void> {
  if (rows.length === 0) return
  try {
    const db = getDb()
    await db
      .insert(reddit_classifications)
      .values(
        rows.map((r) => ({
          post_id: r.post_id,
          classification: r.classification,
        })),
      )
      .onConflictDoUpdate({
        target: reddit_classifications.post_id,
        set: {
          classification: sql`excluded.classification`,
          cached_at: sql`now()`,
        },
      })
  } catch (err) {
    console.warn('[reddit-cache] upsert failed:', (err as Error).message)
  }
}
