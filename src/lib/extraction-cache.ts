/**
 * Extraction-result cache for `extractListingFromHTML`.
 *
 * Why this exists: extraction is the single most expensive thing per URL —
 * Haiku reads up to 60kB of HTML and emits a 2k-token tool call. On the
 * single-URL ingest path (`/api/ingest`) and on Tier-1 fallback inside the
 * scraper pipeline, the same URL gets re-extracted every time it appears.
 *
 * Cache key: SHA-1 of the URL. Fixed-length, cheap, avoids the headache of
 * very long Apify-generated URLs as the PK.
 *
 * TTL: 7 days. Listings can change (price drops, new photos, renewed), so we
 * don't pin a stale extraction forever — but 7 days is long enough to cover
 * any reasonable re-fetch cadence.
 *
 * Failure mode: any DB error here is logged and swallowed. The extractor
 * still runs; just no speedup.
 *
 * Schema-shape note: we store the full `NewListing` payload as `raw_listing`
 * jsonb. `posted_at` and `available_date` are serialized to ISO strings via
 * `JSON.stringify` so we re-hydrate them with `new Date()` on read.
 */

import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { extraction_cache } from '@/db/schema'
import type { NewListing } from '@/types'

const TTL_MS = 7 * 24 * 60 * 60 * 1000

function urlHash(url: string): string {
  return createHash('sha1').update(url).digest('hex')
}

/**
 * Read a cached extraction. Returns null when missing or stale (>7d old).
 */
export async function getCachedExtraction(
  sourceUrl: string,
): Promise<NewListing | null> {
  try {
    const db = getDb()
    const rows = await db
      .select({
        raw_listing: extraction_cache.raw_listing,
        cached_at: extraction_cache.cached_at,
      })
      .from(extraction_cache)
      .where(eq(extraction_cache.url_hash, urlHash(sourceUrl)))
      .limit(1)
    if (rows.length === 0) return null
    const r = rows[0]
    const ts = r.cached_at ? new Date(r.cached_at).getTime() : 0
    if (Date.now() - ts > TTL_MS) return null
    const stored = r.raw_listing as Record<string, unknown> & {
      posted_at?: string | null
      available_date?: string | null
    }
    // Re-hydrate Date fields that lost their type via jsonb roundtrip.
    return {
      ...(stored as unknown as NewListing),
      posted_at: stored.posted_at ? new Date(stored.posted_at) : null,
      available_date: stored.available_date
        ? new Date(stored.available_date)
        : null,
    }
  } catch (err) {
    console.warn('[extraction-cache] read failed:', (err as Error).message)
    return null
  }
}

/**
 * Upsert a cached extraction. On conflict, replaces the payload and bumps
 * cached_at to now().
 */
export async function setCachedExtraction(
  sourceUrl: string,
  listing: NewListing,
): Promise<void> {
  try {
    const db = getDb()
    await db
      .insert(extraction_cache)
      .values({
        url_hash: urlHash(sourceUrl),
        source_url: sourceUrl,
        raw_listing: listing as unknown as Record<string, unknown>,
      })
      .onConflictDoUpdate({
        target: extraction_cache.url_hash,
        set: {
          raw_listing: sql`excluded.raw_listing`,
          source_url: sql`excluded.source_url`,
          cached_at: sql`now()`,
        },
      })
  } catch (err) {
    console.warn('[extraction-cache] write failed:', (err as Error).message)
  }
}
