/**
 * Manual dedupe entrypoint. Runs `markDuplicates()` against the live DB.
 *
 * Usage:
 *   npx tsx scripts/dedupe.ts
 *
 * (Add `"dedupe": "tsx scripts/dedupe.ts"` to package.json scripts when
 * convenient — flagged in the integrator report rather than mutating
 * package.json from here.)
 */
import { markDuplicates } from '@/lib/listing-dedupe'

async function main() {
  const start = Date.now()
  const result = await markDuplicates()
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(
    `[dedupe] ${result.canonicals} canonical clusters, ${result.deduped} listings deactivated in ${elapsed}s`
  )
}

main().catch((err) => {
  console.error('[dedupe] failed:', err)
  process.exit(1)
})
