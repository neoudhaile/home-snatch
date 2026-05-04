/**
 * POST /api/ask  —  stream a follow-up answer about a single listing.
 *
 * Body: { listing_id: string, question: string }
 *
 * Returns text/event-stream. Each `data:` chunk is a UTF-8 fragment of the
 * model's text answer. Terminates with a `data: [DONE]` sentinel and an
 * `event: end` line so the client can close cleanly.
 *
 * Model: Sonnet 4.6 (per `MODELS.reason`). System prompt is prompt-cached.
 */

import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import { getListingDetail } from '@/lib/listing-helpers'
import { loadAllProfileFiles, joinProfileNames } from '@/lib/profile-set'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const Body = z.object({
  listing_id: z.string().min(1),
  question: z.string().min(1).max(2000),
})

/**
 * The cached portion of the system prompt. Stays identical across requests so
 * the prompt cache hits. The dynamic name section is appended *before* this
 * block in a separate, non-cached text part.
 */
const SYSTEM_PROMPT_CACHED = `You are answering a follow-up question about a single NYC apartment listing for the buyer(s). You have the full listing facts plus the public-data enrichment. Answer in 1-3 sentences max, ground in facts you have, never invent. If the answer requires data not present, say so.

Voice rules:
- NYC-direct. Prefer numbers over adjectives.
- No real-estate prose ("luxury", "modern", "stunning", "must-see", "charming", "cozy").
- No em dashes. Use periods, commas, parentheses.
- Do not invent commute times, addresses, or amenities. If the listing block doesn't mention something, say "not in the listing".`

async function buildBuyerHeader(): Promise<string> {
  const profiles = await loadAllProfileFiles()
  if (profiles.length === 0) return 'Buyer: (no profiles configured).'
  const names = profiles.map((p) => p.name)
  return `Buyer: ${joinProfileNames(names)}.`
}

function buildListingBlock(args: {
  listing: Awaited<ReturnType<typeof getListingDetail>>
  question: string
}): string {
  const l = args.listing
  if (!l) return `Listing missing.\n\nQuestion: ${args.question}`
  const score = l.score
  const vibe = l.vibe
  const ns = l.nearest_subway
  const facts = (l.score?.rationale_jsonb as { top_facts?: string[] } | null)?.top_facts ?? []

  const block = {
    listing: {
      id: l.id,
      source: l.source,
      title: l.title,
      description: l.description ?? null,
      price_monthly: l.price_monthly,
      beds: l.beds,
      baths: l.baths,
      sqft: l.sqft,
      neighborhood: l.neighborhood,
      borough: l.borough,
      address: l.address,
      lat: l.lat,
      lng: l.lng,
      amenities: l.amenities ?? [],
      photos_count: (l.photos ?? []).length,
      contact: l.contact ?? null,
      application: l.application ?? null,
      posted_at: l.posted_at,
      pet_friendly: l.pet_friendly,
      furnished: l.furnished,
      lease_term: l.lease_term,
    },
    score: score
      ? {
          score: score.score,
          headline: score.headline,
          concerns: score.concerns,
          top_facts: facts,
        }
      : null,
    nearest_subway: ns,
    hpd_count_12mo: l.hpd_count_12mo ?? 0,
    rent_stabilized: l.rent_stabilized ?? false,
    vibe: vibe
      ? {
          nta_name: vibe.nta_name,
          borough: vibe.borough,
          noise: vibe.noise,
          walkability: vibe.walkability,
          greenness: vibe.greenness,
          nightlife: vibe.nightlife,
          cafes: vibe.cafes,
        }
      : null,
  }

  return `Listing block:\n\n${JSON.stringify(block, null, 2)}\n\nQuestion: ${args.question}`
}

function sseEncode(data: string, event?: string): string {
  // SSE protocol: each `data:` line, terminated by a blank line.
  // Multi-line payloads need every line prefixed with `data: `.
  const safe = data.replace(/\r\n|\r/g, '\n')
  const dataLines = safe.split('\n').map((l) => `data: ${l}`).join('\n')
  const head = event ? `event: ${event}\n` : ''
  return `${head}${dataLines}\n\n`
}

export async function POST(req: Request) {
  // 1. validate body
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

  // 2. load listing context
  let listing: Awaited<ReturnType<typeof getListingDetail>>
  try {
    listing = await getListingDetail(body.listing_id)
  } catch (err) {
    console.error('[api/ask] getListingDetail failed', err)
    return Response.json(
      { error: 'db_error', message: (err as Error).message },
      { status: 500 }
    )
  }
  if (!listing) {
    return Response.json({ error: 'not_found', listing_id: body.listing_id }, { status: 404 })
  }

  // 3. build the streamed response
  const userPrompt = buildListingBlock({ listing, question: body.question })
  const buyerHeader = await buildBuyerHeader()
  const client = getAnthropic()

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const messageStream = client.messages.stream({
        model: MODELS.reason,
        max_tokens: 600,
        temperature: 0.3,
        // Two-part system: a short, dynamic buyer header (NOT cached, so changes
        // when profiles change) + the cached bulk of the prompt. Anthropic's
        // prompt cache keys on prefix-equality, so we put the dynamic part first
        // and the cache_control marker on the long, stable part.
        system: [
          { type: 'text', text: buyerHeader },
          {
            type: 'text',
            text: SYSTEM_PROMPT_CACHED,
            cache_control: { type: 'ephemeral' },
          },
        ] as Anthropic.TextBlockParam[],
        messages: [{ role: 'user', content: userPrompt }],
      })

      messageStream.on('text', (delta: string) => {
        try {
          controller.enqueue(encoder.encode(sseEncode(delta)))
        } catch {
          // controller already closed (client aborted) — ignore.
        }
      })

      messageStream.on('error', (err) => {
        console.error('[api/ask] stream error', err)
        try {
          controller.enqueue(encoder.encode(sseEncode(`stream error: ${err.message}`, 'error')))
        } catch {}
      })

      try {
        await messageStream.finalMessage()
      } catch (err) {
        console.error('[api/ask] finalMessage failed', err)
      } finally {
        try {
          controller.enqueue(encoder.encode(sseEncode('[DONE]', 'end')))
        } catch {}
        controller.close()
      }
    },
    cancel() {
      // Client disconnected; the SDK's stream is owned by `start`'s closure.
      // The model run completes server-side; we just stop pushing bytes.
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
