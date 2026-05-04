/**
 * POST /api/search — natural-language search filter extraction.
 *
 * Body: { query: string }
 *
 * Returns: { filters: ExtractedFilters, query: string }
 *
 * Calls Haiku 4.5 via `parseSearchQuery` (in `lib/search.ts`) with forced
 * tool-use against the `extract_filters` JSON schema. The page consumer
 * applies the returned filters via `getRankedFeed` + `applyKeywordFilter`.
 *
 * The system prompt is prompt-cached (see `lib/search.ts`).
 */

import { z } from 'zod'
import { parseSearchQuery } from '@/lib/search'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Body = z.object({
  query: z.string().min(1).max(500),
})

export async function POST(req: Request) {
  let body: z.infer<typeof Body>
  try {
    const raw = (await req.json()) as unknown
    body = Body.parse(raw)
  } catch (err) {
    return Response.json(
      { error: 'bad_request', message: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 }
    )
  }

  try {
    const filters = await parseSearchQuery(body.query)
    return Response.json({ filters, query: body.query })
  } catch (err) {
    console.error('[api/search] parseSearchQuery failed', err)
    return Response.json(
      { error: 'extraction_failed', message: (err as Error).message },
      { status: 500 }
    )
  }
}
