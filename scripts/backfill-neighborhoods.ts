/**
 * One-time backfill: fill `listings.neighborhood` for the ~563 active rows that
 * arrived from Craigslist umbrella tags / Reddit / Listings Project without a
 * neighborhood string, AND canonicalize already-set neighborhoods so they
 * converge to the alias-map's canonical name.
 *
 * Strategy per row:
 *   1. If neighborhood is already set: run `canonicalize(...)` and update if
 *      it differs (cheap normalization, no I/O).
 *   2. If null: try to parse from `address` (last comma-segment, then resolve
 *      via the alias map).
 *   3. If null: try `geocodeNeighborhood` against the existing centroid LUT
 *      using any inline neighborhood mention from the title/description (we
 *      walk the alias index for substring hits — same map the SQL filter
 *      uses now).
 *   4. If null: try lat/lng → nearest-canonical-centroid (best-effort, only
 *      kicks in for rows that have coordinates; <500m wins, otherwise punt).
 *   5. Still null: leave alone, log per-source counts at the end.
 *
 * Usage:
 *   npm run backfill:neighborhoods
 */

import { eq, isNull, sql } from 'drizzle-orm'
import { listings as listingsTable } from '@/db/schema'
import { getDb } from '@/lib/db'
import {
  CANONICAL_NEIGHBORHOODS,
  canonicalize,
  resolveNeighborhood,
} from '@/lib/neighborhoods'

type Row = {
  id: string
  source: string
  title: string | null
  description: string | null
  address: string | null
  neighborhood: string | null
  lat: number | null
  lng: number | null
}

/**
 * Try to extract a neighborhood string from a free-text address. Most NYC
 * Craigslist addresses arrive as "<street>, <neighborhood>, <city>" or just
 * "<street>, <city>". We pull the second-from-last comma segment and try to
 * resolve it.
 */
function neighborhoodFromAddress(address: string | null): string | null {
  if (!address) return null
  const parts = address
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  if (parts.length < 2) return null
  // Walk from right to left, skipping "NY" / "New York" / zip-only segments.
  for (let i = parts.length - 1; i >= 0; i--) {
    const seg = parts[i]
    if (/^\d{5}(-\d{4})?$/.test(seg)) continue
    if (/^(ny|new york|new york city|nyc|usa|united states)$/i.test(seg)) continue
    const hit = resolveNeighborhood(seg)
    if (hit) return hit.canonical
  }
  return null
}

/**
 * Walk every alias and check if it appears as a whole-word substring in the
 * given haystack. Used as a last-resort match against title/description so
 * "looking to sublet my Bushwick studio" still resolves to Bushwick.
 *
 * We only match aliases ≥4 chars to avoid false hits ("LIC" inside a longer
 * word, etc.). The longer aliases run first so we match the most-specific
 * name, not its parent.
 */
function neighborhoodFromText(text: string | null): string | null {
  if (!text) return null
  const hay = text.toLowerCase()
  type Hit = { canonical: string; len: number }
  const hits: Hit[] = []
  for (const n of CANONICAL_NEIGHBORHOODS) {
    const allNames = [n.canonical, n.display, ...n.aliases]
    for (const name of allNames) {
      if (name.length < 4) continue
      const re = new RegExp(`\\b${name.toLowerCase().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`)
      if (re.test(hay)) {
        hits.push({ canonical: n.canonical, len: name.length })
        break
      }
    }
  }
  if (hits.length === 0) return null
  // Prefer the longest match (most specific).
  hits.sort((a, b) => b.len - a.len)
  return hits[0].canonical
}

/**
 * Approximate "closest canonical centroid" lookup. Quick equirectangular
 * distance — within NYC the curvature error is well under 100m, fine for a
 * "what neighborhood is this lat/lng nearest" decision.
 */
function neighborhoodFromLatLng(lat: number, lng: number): string | null {
  let best: { canonical: string; d: number } | null = null
  for (const n of CANONICAL_NEIGHBORHOODS) {
    if (n.lat == null || n.lng == null) continue
    const dLat = (lat - n.lat) * 111_320
    const dLng = (lng - n.lng) * 111_320 * Math.cos((lat * Math.PI) / 180)
    const d = Math.sqrt(dLat * dLat + dLng * dLng)
    if (!best || d < best.d) best = { canonical: n.canonical, d }
  }
  // Reject if the nearest centroid is >2km away — coords are probably in NJ
  // / a borough we don't catalogue, and a wrong neighborhood is worse than
  // null.
  if (!best || best.d > 2_000) return null
  return best.canonical
}

async function main() {
  const db = getDb()
  const start = Date.now()

  // Fetch every active row with id + the columns we need to derive from.
  // ~1,900 rows total → fits comfortably in memory; one round trip.
  const rows = (await db
    .select({
      id: listingsTable.id,
      source: listingsTable.source,
      title: listingsTable.title,
      description: listingsTable.description,
      address: listingsTable.address,
      neighborhood: listingsTable.neighborhood,
      lat: listingsTable.lat,
      lng: listingsTable.lng,
    })
    .from(listingsTable)
    .where(eq(listingsTable.is_active, true))) as Row[]

  console.log(`[backfill-neighborhoods] scanning ${rows.length} active rows`)

  const recoveredByCanonical = new Map<string, number>()
  const renamedByPair = new Map<string, number>()
  const stats = {
    already_canonical: 0,
    renamed: 0,
    recovered_from_address: 0,
    recovered_from_text: 0,
    recovered_from_latlng: 0,
    still_null: 0,
    null_with_no_address: 0,
    null_per_source: new Map<string, number>(),
  }

  // Batch updates 200 at a time so we don't pile up Postgres locks.
  const BATCH = 200
  let pending: Array<{ id: string; neighborhood: string }> = []

  async function flush() {
    if (pending.length === 0) return
    // Postgres CASE WHEN id = $1 THEN $2 ... — batch in one round trip per
    // 200 rows.
    const cases = sql.join(
      pending.map((p) => sql`WHEN ${p.id}::uuid THEN ${p.neighborhood}`),
      sql` `,
    )
    const ids = sql.join(
      pending.map((p) => sql`${p.id}::uuid`),
      sql`, `,
    )
    await db.execute(sql`
      UPDATE listings
      SET neighborhood = CASE id ${cases} END
      WHERE id IN (${ids})
    `)
    pending = []
  }

  for (const row of rows) {
    let resolved: string | null = null
    let how: 'canonical' | 'rename' | 'address' | 'text' | 'latlng' | 'none' = 'none'

    if (row.neighborhood) {
      const canon = canonicalize(row.neighborhood)
      if (canon == null) {
        stats.already_canonical += 1 // unknown but non-null; leave alone
        continue
      }
      if (canon === row.neighborhood) {
        stats.already_canonical += 1
        continue
      }
      resolved = canon
      how = 'rename'
    } else {
      // Try address → text → lat/lng.
      resolved = neighborhoodFromAddress(row.address)
      if (resolved) {
        how = 'address'
      } else {
        resolved = neighborhoodFromText(`${row.title ?? ''} ${row.description ?? ''}`)
        if (resolved) {
          how = 'text'
        } else if (row.lat != null && row.lng != null) {
          resolved = neighborhoodFromLatLng(row.lat, row.lng)
          if (resolved) how = 'latlng'
        }
      }
    }

    if (!resolved) {
      stats.still_null += 1
      if (!row.address) stats.null_with_no_address += 1
      stats.null_per_source.set(
        row.source,
        (stats.null_per_source.get(row.source) ?? 0) + 1,
      )
      continue
    }

    // Tally
    recoveredByCanonical.set(resolved, (recoveredByCanonical.get(resolved) ?? 0) + 1)
    if (how === 'rename') {
      stats.renamed += 1
      const k = `${row.neighborhood} → ${resolved}`
      renamedByPair.set(k, (renamedByPair.get(k) ?? 0) + 1)
    } else if (how === 'address') stats.recovered_from_address += 1
    else if (how === 'text') stats.recovered_from_text += 1
    else if (how === 'latlng') stats.recovered_from_latlng += 1

    pending.push({ id: row.id, neighborhood: resolved })
    if (pending.length >= BATCH) {
      await flush()
    }
  }
  await flush()

  // ── Report ────────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log('')
  console.log(`[backfill-neighborhoods] done in ${elapsed}s`)
  console.log(`  already canonical:         ${stats.already_canonical}`)
  console.log(`  canonicalized in place:    ${stats.renamed}`)
  console.log(`  recovered from address:    ${stats.recovered_from_address}`)
  console.log(`  recovered from text:       ${stats.recovered_from_text}`)
  console.log(`  recovered from lat/lng:    ${stats.recovered_from_latlng}`)
  console.log(`  still null:                ${stats.still_null}`)
  console.log(`    of which no address:     ${stats.null_with_no_address}`)
  if (stats.null_per_source.size > 0) {
    console.log('  remaining nulls by source:')
    const entries = Array.from(stats.null_per_source.entries()).sort(
      (a, b) => b[1] - a[1],
    )
    for (const [src, n] of entries) console.log(`    ${src}: ${n}`)
  }
  console.log('')
  console.log('  recovered/renamed counts per canonical:')
  const top = Array.from(recoveredByCanonical.entries()).sort((a, b) => b[1] - a[1])
  for (const [name, n] of top.slice(0, 30)) console.log(`    ${name.padEnd(30)} ${n}`)
  if (renamedByPair.size > 0) {
    console.log('')
    console.log('  most-frequent renames (top 10):')
    const ren = Array.from(renamedByPair.entries()).sort((a, b) => b[1] - a[1]).slice(0, 10)
    for (const [pair, n] of ren) console.log(`    ${pair.padEnd(60)} ${n}`)
  }

  // Verify the post-state count of nulls.
  const [{ n: nullsAfter }] = (await db.execute(
    sql`SELECT count(*)::int AS n FROM listings WHERE is_active = true AND neighborhood IS NULL`,
  )) as unknown as Array<{ n: number }>
  console.log('')
  console.log(`[backfill-neighborhoods] active rows still null after run: ${nullsAfter}`)
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[backfill-neighborhoods] failed:', err)
    process.exit(1)
  })
