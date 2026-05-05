/**
 * Manual rescore — loads all listings, scores them against the joint profile
 * set from src/profiles/, writes scores back to DB. Used after a fresh scrape
 * or after profile edits.
 */
import { getDb } from '@/lib/db'
import { listings, scores } from '@/db/schema'
import { loadAllProfileFiles } from '@/lib/profile-set'
import { scoreListings } from '@/agents/score'

async function main() {
  const start = Date.now()
  const profiles = await loadAllProfileFiles()
  console.log('[rescore] profiles:', profiles.map((p) => p.slug).join(', ') || '(none)')
  if (profiles.length === 0) {
    console.log('[rescore] no usable profiles — fill src/profiles/*.json (or use /setup)')
    process.exit(0)
  }

  const db = getDb()
  const allListings = await db.select().from(listings)
  console.log('[rescore] listings:', allListings.length)
  if (allListings.length === 0) {
    console.log('[rescore] no listings to score')
    process.exit(0)
  }

  // Load subway stations for commute enrichment (small table, ~470 rows max).
  const { subway_stations } = await import('@/db/schema')
  const stations = await db.select().from(subway_stations)

  // skipAlreadyScored: true makes a fresh rescore on an unchanged DB drop
  // from ~90s to <5s (we filter out listings whose profile_set_hash row
  // already exists). When the user *does* want a forced rescore (after a
  // prompt edit), they should clear the scores table or flip this flag.
  // Force flag: `npm run rescore -- --force` rescores everything regardless of
  // whether a row already exists for the current profile_set_hash. Use after
  // semantic profile edits that don't change the hash (e.g. vibe value tweaks
  // — current hashing only covers vibe keys).
  const force = process.argv.includes('--force')
  const out = await scoreListings(allListings, {
    profilesOverride: profiles,
    hpdByListingId: new Map(),
    rentStabByListingId: new Map(),
    stations,
    skipAlreadyScored: !force,
  })
  console.log('[rescore] scored:', out.length)

  let written = 0
  for (const s of out) {
    await db
      .insert(scores)
      .values(s)
      .onConflictDoUpdate({ target: [scores.listing_id, scores.profile_set_hash], set: s })
    written++
    if (written % 10 === 0) console.log(`[rescore] wrote ${written}/${out.length}`)
  }
  console.log(`[rescore] done in ${Math.round((Date.now() - start) / 1000)}s — wrote ${written} scores`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[rescore] fatal', err)
  process.exit(1)
})
