/**
 * Manual refresh entrypoint. Re-fetches stale listings (default: anything not
 * seen in the last 24h, capped at 50).
 *
 * Usage:
 *   npx tsx scripts/refresh.ts
 *   npx tsx scripts/refresh.ts --hours=48 --limit=200
 *
 * (Add `"refresh": "tsx scripts/refresh.ts"` to package.json scripts when
 * convenient — flagged in the integrator report rather than mutating
 * package.json from here.)
 */
import { refreshStaleListings } from '@/lib/listing-freshness'

function parseArgs(): { older_than_hours?: number; limit?: number } {
  const out: { older_than_hours?: number; limit?: number } = {}
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(hours|limit)=(\d+)$/)
    if (!m) continue
    const n = Number.parseInt(m[2], 10)
    if (!Number.isFinite(n)) continue
    if (m[1] === 'hours') out.older_than_hours = n
    else out.limit = n
  }
  return out
}

async function main() {
  const opts = parseArgs()
  const start = Date.now()
  const result = await refreshStaleListings(opts)
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(
    `[refresh] checked=${result.checked} gone=${result.gone} refreshed=${result.refreshed} in ${elapsed}s`
  )
}

main().catch((err) => {
  console.error('[refresh] failed:', err)
  process.exit(1)
})
