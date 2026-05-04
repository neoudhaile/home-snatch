/**
 * Admin Insights endpoint.
 *
 *   GET  /api/admin/insights?type=market       → MarketSummary
 *   GET  /api/admin/insights?type=anomalies    → Anomaly[]
 *   GET  /api/admin/insights?type=cleanup      → CleanupSuggestion[]
 *
 *   POST /api/admin/insights
 *     { action: 'apply-cleanup', listing_id: string, action_type: 'deactivate' | 'delete' }
 *
 * Auth (v0): same as `/api/admin/dq`. `x-admin-pass` header against ADMIN_PASS;
 * if ADMIN_PASS is unset (dev), allow.
 */
import { z } from 'zod'
import {
  applyCleanup,
  detectAnomalies,
  generateMarketSummary,
  recommendCleanup,
} from '@/lib/insights'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 120

function authorized(req: Request): boolean {
  const expected = process.env.ADMIN_PASS
  if (!expected) return true
  const got = req.headers.get('x-admin-pass') ?? ''
  return got === expected
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  const url = new URL(req.url)
  const type = url.searchParams.get('type')
  switch (type) {
    case 'market':
      return Response.json(await generateMarketSummary())
    case 'anomalies':
      return Response.json(await detectAnomalies())
    case 'cleanup':
      return Response.json(await recommendCleanup())
    default:
      return Response.json(
        { error: 'bad_request', message: 'type must be one of: market, anomalies, cleanup' },
        { status: 400 }
      )
  }
}

const PostBody = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('apply-cleanup'),
    listing_id: z.string().min(1),
    action_type: z.enum(['deactivate', 'delete']),
  }),
])

export async function POST(req: Request) {
  if (!authorized(req)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 })
  }
  let body: z.infer<typeof PostBody>
  try {
    body = PostBody.parse(await req.json())
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'bad request'
    return Response.json({ error: 'bad_request', message: msg }, { status: 400 })
  }

  switch (body.action) {
    case 'apply-cleanup': {
      try {
        const result = await applyCleanup({
          listing_id: body.listing_id,
          action_type: body.action_type,
        })
        return Response.json(result)
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'cleanup failed'
        return Response.json({ error: 'cleanup_failed', message: msg }, { status: 500 })
      }
    }
  }
}
