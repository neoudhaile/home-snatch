import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from '@/db/schema'

let _db: ReturnType<typeof drizzle> | null = null

export function getDb() {
  if (_db) return _db
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL not set — see .env.local.example')
  const client = postgres(url, {
    prepare: false,
    max: process.env.NODE_ENV === 'production' ? 5 : 1,
  })
  _db = drizzle(client, { schema })
  return _db
}

export { schema }
