/**
 * GET /api/feed-since?since=<ISO timestamp>
 *
 * Returns the count of active listings whose `last_seen_at` is greater than
 * the supplied timestamp. Used by the client-side poller to render the
 * "+N new listings — refresh feed" indicator.
 *
 * Why `last_seen_at` and not `posted_at`: a Craigslist post that was first
 * seen 4 days ago but reappeared in today's scrape (re-listed) has
 * `posted_at` 4 days old and `last_seen_at` minutes-old — that's a fresh
 * signal the user wants to know about.
 *
 * Auth: same as feed (none, public). The query is read-only and cheap.
 */

import { sql } from 'drizzle-orm'
import { getDb } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const sinceRaw = url.searchParams.get('since')
  if (!sinceRaw) {
    return Response.json({ error: 'missing_since' }, { status: 400 })
  }
  const since = new Date(sinceRaw)
  if (Number.isNaN(since.getTime())) {
    return Response.json({ error: 'invalid_since' }, { status: 400 })
  }

  // No DATABASE_URL → respond honestly with 0 so the chip stays hidden.
  if (!process.env.DATABASE_URL) {
    return Response.json({ count: 0 })
  }

  try {
    const db = getDb()
    const rows = (await db.execute(sql`
      SELECT count(*)::int AS n
      FROM listings
      WHERE is_active = true AND last_seen_at > ${since}
    `)) as unknown as Array<{ n: number }>
    const count = rows[0]?.n ?? 0
    return Response.json({ count })
  } catch (err) {
    console.warn('[feed-since] db error', err)
    return Response.json({ count: 0 })
  }
}
