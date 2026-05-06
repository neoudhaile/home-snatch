/**
 * One-shot migration: create the `score_batches` table.
 * drizzle-kit push trips on a CHECK-constraint introspection bug, so we
 * apply the raw DDL directly. Idempotent.
 */
import 'dotenv/config'
import postgres from 'postgres'

async function main() {
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL missing')
  const sql = postgres(url, { max: 1 })

  await sql`
    CREATE TABLE IF NOT EXISTS score_batches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      batch_id text NOT NULL UNIQUE,
      status text NOT NULL DEFAULT 'processing',
      profile_set_hash text NOT NULL,
      request_count integer NOT NULL,
      result_count integer NOT NULL DEFAULT 0,
      created_at timestamp NOT NULL DEFAULT now(),
      completed_at timestamp,
      error text
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS score_batches_status_idx ON score_batches (status)`
  console.log('[migrate] score_batches ready')
  await sql.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
