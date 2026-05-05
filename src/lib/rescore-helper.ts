/**
 * Shared "chain a rescore after fresh listings land" helper.
 *
 * Why this exists: only the GH Actions `scrape.yml` workflow used to chain
 * rescore after ingest. The Vercel cron (/api/cron/scrape), the manual
 * /api/refresh button, and the admin "Run scrape now" all left fresh
 * listings unscored until the next GH Actions tick (up to 2h gap), so users
 * saw fresh feed cards with no score badge.
 *
 * Strategy:
 *   - load profiles via the DB-first loader
 *   - pre-resolve subway stations + the empty HPD/rent-stab maps that
 *     scoreListings expects
 *   - call scoreListings with skipAlreadyScored=true so we don't waste
 *     budget rescoring rows that already have a row for this profile_set_hash
 *   - upsert each score row with onConflictDoUpdate
 *
 * Use `chainRescoreAfter(ids)` to scope the work to just-ingested rows; pass
 * `null` to rescore every active listing.
 *
 * IMPORTANT: callers should wrap the call in `after(() => chainRescoreAfter(...))`
 * (from `next/server`) so the HTTP response goes out fast and the rescore
 * keeps running. We intentionally do NOT wrap inside this helper because
 * after() is only callable inside a request scope; cron/test paths may want
 * to await it directly.
 */

import { sql, and, inArray, eq } from 'drizzle-orm'
import { listings, scores, subway_stations } from '@/db/schema'
import { getDb } from '@/lib/db'
import { scoreListings } from '@/agents/score'
import { loadAllProfileFiles } from '@/lib/profile-set'
import type { Listing, SubwayStation } from '@/types'

export type ChainRescoreResult = {
  scored: number
  considered: number
  skipped_reason?: 'no_profiles' | 'no_listings'
}

/**
 * Score newly-ingested listings (or all active listings if `ingestedIds` is
 * null/empty). Returns the count of score rows actually written.
 *
 * Best-effort: any thrown error is logged + swallowed so the calling
 * cron/refresh path doesn't 500 because rescore failed.
 */
export async function chainRescoreAfter(
  ingestedIds: string[] | null,
): Promise<ChainRescoreResult> {
  try {
    const db = getDb()

    const profiles = await loadAllProfileFiles()
    if (profiles.length === 0) {
      return { scored: 0, considered: 0, skipped_reason: 'no_profiles' }
    }

    // Pull active listings, scoped to the just-ingested IDs when caller
    // supplies them — keeps the rescore work proportional to the ingest.
    let target: Listing[]
    if (ingestedIds && ingestedIds.length > 0) {
      // Only score listings that are still active; an upsert that flips a row
      // inactive shouldn't pull it into the rescore.
      target = (await db
        .select()
        .from(listings)
        .where(
          and(eq(listings.is_active, true), inArray(listings.id, ingestedIds)),
        )) as Listing[]
    } else {
      target = (await db.select().from(listings).where(eq(listings.is_active, true))) as Listing[]
    }

    if (target.length === 0) {
      return { scored: 0, considered: 0, skipped_reason: 'no_listings' }
    }

    const stations = (await db.select().from(subway_stations)) as SubwayStation[]

    const newScores = await scoreListings(target, {
      profilesOverride: profiles,
      hpdByListingId: new Map(),
      rentStabByListingId: new Map(),
      stations,
      skipAlreadyScored: true,
    })

    for (const row of newScores) {
      await db
        .insert(scores)
        .values(row)
        .onConflictDoUpdate({
          target: [scores.listing_id, scores.profile_set_hash],
          set: {
            score: row.score,
            headline: row.headline,
            concerns: row.concerns,
            rationale_jsonb: row.rationale_jsonb,
            computed_at: sql`now()`,
          },
        })
    }

    console.log(
      `[rescore-helper] scored ${newScores.length}/${target.length} listings`,
    )
    return { scored: newScores.length, considered: target.length }
  } catch (err) {
    console.error('[rescore-helper] failed:', (err as Error).message)
    return { scored: 0, considered: 0 }
  }
}
