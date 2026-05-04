/**
 * Entrypoint for `npm run seed` — pulls NYC Open Data into Postgres.
 *
 * Requires `DATABASE_URL` to be set in `.env.local` (or the shell). We let the
 * Drizzle client lazy-throw with a clear message if it's missing.
 */

import { seedNycOpenData } from '@/db/seed'

async function main() {
  console.log('[seed] starting NYC Open Data ingest…')
  const start = Date.now()
  await seedNycOpenData()
  const ms = Date.now() - start
  console.log(`[seed] done in ${(ms / 1000).toFixed(1)}s`)
}

main().catch((err) => {
  console.error('[seed] fatal', err)
  process.exit(1)
})
