import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/db/schema'

let _db: ReturnType<typeof drizzle> | null = null

export function getDb() {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set — see .env.local.example')
  // Supabase Transaction-mode pooler (port 6543) terminates idle sessions and
  // does not support prepared statements. Settings tuned for dev + serverless:
  //   prepare: false      — required for pooler transaction mode
  //   max: 5              — small pool; dev had max:1 which queued every query
  //                        behind one stale-prone connection
  //   idle_timeout: 10    — close local idle connections after 10s; pooler
  //                        kills them anyway, this avoids the broken-pipe
  //                        retry storm
  //   max_lifetime: 60*30 — recycle every 30min as belt-and-suspenders
  //   connect_timeout: 10 — fail fast instead of hanging on bad creds
  const client = postgres(url, {
    prepare: false,
    max: 5,
    idle_timeout: 10,
    max_lifetime: 60 * 30,
    connect_timeout: 10,
  })
  _db = drizzle(client, { schema })
  return _db
}

export { schema }
