/**
 * GET /api/cron/batch-poll — Vercel Cron entrypoint for the Anthropic
 * Message Batch lifecycle.
 *
 * Auth: `Authorization: Bearer ${CRON_SECRET}` (same convention as scrape).
 *
 * Behavior:
 *   - Loads `score_batches` rows where status='processing'.
 *   - For each, polls Anthropic. If the batch is still in_progress, skip it.
 *   - If ended/errored, drains results into `scores` via `consumeScoringBatch`,
 *     marks the row complete, and revalidates the feed cache.
 *
 * Cost: this is the bulk-rescore lane — ~6× cheaper than the original Sonnet
 * synchronous path (Sonnet→Haiku is 3×, Batch API is another 2×).
 *
 * Cadence: every 5 minutes is a reasonable balance between responsiveness
 * (Anthropic batches typically end well within an hour) and Vercel cron
 * usage. See vercel.json.
 */

import { eq } from 'drizzle-orm'
import { revalidateTag } from 'next/cache'
import { getDb } from '@/lib/db'
import { score_batches, subway_stations } from '@/db/schema'
import { consumeScoringBatch } from '@/agents/score'
import type { SubwayStation } from '@/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 300

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true // dev-only
  const got = req.headers.get('authorization') ?? ''
  return got === `Bearer ${secret}`
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }

  const db = getDb()
  const open = await db
    .select()
    .from(score_batches)
    .where(eq(score_batches.status, 'processing'))

  if (open.length === 0) {
    return Response.json({ open: 0 })
  }

  // Pull stations once per cron run; every consumed batch shares them.
  const stations = (await db.select().from(subway_stations)) as SubwayStation[]

  let stillProcessing = 0
  let completed = 0
  let totalWritten = 0
  let totalErrors = 0
  const summary: Array<{
    batch_id: string
    status: string
    written: number
    errors: number
  }> = []

  for (const row of open) {
    try {
      const r = await consumeScoringBatch({
        batchRowId: row.id,
        batchId: row.batch_id,
        profileSetHash: row.profile_set_hash,
        stations,
        hpdByListingId: new Map(),
        rentStabByListingId: new Map(),
      })
      summary.push({
        batch_id: row.batch_id,
        status: r.status,
        written: r.written,
        errors: r.errors,
      })
      if (r.status === 'in_progress') {
        stillProcessing += 1
      } else {
        completed += 1
        totalWritten += r.written
        totalErrors += r.errors
      }
    } catch (err) {
      console.error(`[cron/batch-poll] failed batch ${row.batch_id}`, err)
      summary.push({
        batch_id: row.batch_id,
        status: 'errored-poll',
        written: 0,
        errors: 1,
      })
      // Don't mark the DB row failed — leave it processing so the next cron
      // tick can retry. If Anthropic itself returns 'errored', consume
      // already updates the row to status='errored'.
    }
  }

  if (totalWritten > 0) {
    try {
      revalidateTag('feed', 'max')
    } catch {
      /* outside request scope */
    }
  }

  return Response.json({
    open: open.length,
    still_processing: stillProcessing,
    completed,
    total_written: totalWritten,
    total_errors: totalErrors,
    summary,
  })
}
