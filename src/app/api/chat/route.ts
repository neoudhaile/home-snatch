/**
 * POST /api/chat — multi-turn chat with tool use, streamed via SSE.
 *
 * Request body:
 *   { messages: ChatMessage[], session_id?: string }
 *
 * SSE protocol:
 *   data: <text>\n\n                              — text deltas
 *   event: tool_use\ndata: <json>\n\n             — model wants to call a tool
 *   event: tool_result\ndata: <json>\n\n          — tool finished, payload summary
 *   event: error\ndata: <text>\n\n                — non-fatal error in stream
 *   event: end\ndata: [DONE]\n\n                  — terminator
 *
 * Tool execution is in-process: tools call `feed-data.ts`, `save-state.ts`,
 * `profile-set.ts` directly. No HTTP fan-out.
 */

import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import { getRankedFeed, getListing } from '@/lib/feed-data'
import {
  saveListing,
  unsaveListing,
  getSavedFor,
  getSavedIntersection,
  isSaver,
  type Saver,
} from '@/lib/save-state'
import { loadProfilesFromJson, mergeProfileConstraints } from '@/lib/profile-set'
import type { RankedListing } from '@/types'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
export const maxDuration = 60

/* ---------------------------- request schema ---------------------------- */

const ContentBlockSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.union([z.string(), z.array(z.unknown())]),
    is_error: z.boolean().optional(),
  }),
])

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(ContentBlockSchema)]),
})

const Body = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(60),
  session_id: z.string().optional(),
})

/* ---------------------------- system prompt ----------------------------- */

const SYSTEM_PROMPT = `You are the homeSnatch chat assistant for Inaan and Mekonnen, two roommates apartment-hunting in NYC. You have access to their joint profile and the live listings database.

Voice rules (NON-NEGOTIABLE):
- NYC-direct. Numbers over adjectives.
- No real-estate prose ("luxury", "modern", "stunning", "must-see", "charming", "cozy").
- No "seamless", "robust", "elevated", "delightful", "vibrant".
- No em dashes. Use periods, commas, parentheses.
- Don't invent data. If you don't have it, say so or call the appropriate tool.

Behavior:
- When the user asks about apartments, USE TOOLS first. Don't guess. Call list_listings or get_saved or compare_listings to get fresh data.
- When citing a listing, mention its score and 2-3 specific facts (price, neighborhood, commute, amenities). Always include the listing ID at the end of the citation.
- Be concise: 1-3 sentences per response unless explicitly asked for more.
- When the user wants to save/unsave, just do it via the tool, don't ask permission.
- When drafting outreach emails, keep them under 80 words. Always include: greeting, who's asking (Inaan + Mekonnen), why this listing in particular (cite a fact), suggested viewing windows, sign-off.
- When the user is making a decision between listings, push toward the data: "Listing X has 0 HPD violations and is rent-stabilized; Listing Y has 4 violations. Which matters more to you?"`

/* ---------------------------- tool definitions -------------------------- */

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'list_listings',
    description:
      'Fetch ranked listings from the database. Use for any "show me", "find", "top N", "what is available" request. Returns structured listing summaries with score, price, beds, neighborhood, score headline, freshness.',
    input_schema: {
      type: 'object',
      properties: {
        filters: {
          type: 'object',
          description: 'Optional filters. Omit any filter that the user did not specify.',
          properties: {
            max_price: { type: 'number', description: 'Max monthly rent in USD.' },
            min_price: { type: 'number' },
            min_beds: { type: 'number', description: '0 = studio, 1, 2, etc.' },
            max_beds: { type: 'number' },
            neighborhood: { type: 'string', description: 'Case-insensitive substring match.' },
            borough: {
              type: 'string',
              enum: ['Manhattan', 'Brooklyn', 'Queens', 'Bronx', 'Staten Island'],
            },
            freshness_days: {
              type: 'number',
              enum: [1, 7, 14, 30],
              description: 'How recent posted_at must be. Default 14.',
            },
            min_score: { type: 'number', description: 'Filter to listings scoring >= this.' },
            pet_friendly: { type: 'boolean' },
            rent_stabilized: { type: 'boolean' },
            max_hpd_12mo: { type: 'number' },
          },
        },
        sort: {
          type: 'string',
          enum: ['score', 'fresh', 'price-asc'],
          description: 'Default "score".',
        },
        limit: { type: 'number', description: 'Max results (1-20). Default 10.' },
      },
    },
  },
  {
    name: 'get_listing',
    description:
      'Fetch full detail for one listing. Use when the user asks for more about a specific listing.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Listing UUID.' } },
      required: ['id'],
    },
  },
  {
    name: 'save_listing',
    description: 'Save a listing to a saver\'s list. Idempotent.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        who: { type: 'string', enum: ['inaan', 'mekonnen'] },
      },
      required: ['id', 'who'],
    },
  },
  {
    name: 'unsave_listing',
    description: 'Remove a listing from a saver\'s list. Idempotent.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        who: { type: 'string', enum: ['inaan', 'mekonnen'] },
      },
      required: ['id', 'who'],
    },
  },
  {
    name: 'get_saved',
    description:
      'Return saved listings. who="both" returns the intersection (apartments BOTH have saved, the decision-relevant set).',
    input_schema: {
      type: 'object',
      properties: {
        who: { type: 'string', enum: ['inaan', 'mekonnen', 'both'] },
      },
      required: ['who'],
    },
  },
  {
    name: 'compare_listings',
    description:
      'Side-by-side compare of N listings. Returns a structured table the assistant can summarize: price, beds, neighborhood, score, headline, top concerns, HPD count, rent-stabilized.',
    input_schema: {
      type: 'object',
      properties: {
        ids: {
          type: 'array',
          items: { type: 'string' },
          description: 'Listing UUIDs. 2-5 ids recommended.',
        },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_profile_summary',
    description:
      'Return the merged Inaan + Mekonnen joint profile (budget, beds, must-haves, deal-breakers, preferred areas, vibes, commute targets). Use to ground recommendations.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'draft_email',
    description:
      'Draft a short outreach email to the listing\'s contact. Returns subject + body. Keep under 80 words.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: { type: 'string' },
        tone: { type: 'string', enum: ['casual', 'formal', 'enthusiastic'] },
        context: {
          type: 'string',
          description: 'Anything specific the user wants mentioned (move date, questions, etc).',
        },
      },
      required: ['listing_id', 'tone'],
    },
  },
]

/* ---------------------------- tool runners ------------------------------ */

type ListingSummary = {
  id: string
  title: string
  score: number
  headline: string
  concerns: string | null
  price_monthly: number | null
  beds: string | null
  baths: string | null
  neighborhood: string | null
  borough: string | null
  source: string
  freshness_hours: number | null
  hpd_count_12mo: number | null
  rent_stabilized: boolean | null
  pet_friendly: boolean | null
  nearest_subway: string | null
  amenities: string[]
}

function summarize(l: RankedListing): ListingSummary {
  const ns = l.nearest_subway
    ? `${l.nearest_subway.name} (${l.nearest_subway.lines.join('/')}) ~${Math.round(l.nearest_subway.distance_m)}m`
    : null
  return {
    id: l.id,
    title: l.title,
    score: l.score?.score ?? 0,
    headline: l.score?.headline ?? '',
    concerns: l.score?.concerns ?? null,
    price_monthly: l.price_monthly,
    beds: l.beds,
    baths: l.baths,
    neighborhood: l.neighborhood,
    borough: l.borough,
    source: l.source,
    freshness_hours: l.freshness_hours ?? null,
    hpd_count_12mo: l.hpd_count_12mo ?? null,
    rent_stabilized: l.rent_stabilized ?? null,
    pet_friendly: l.pet_friendly,
    nearest_subway: ns,
    amenities: l.amenities ?? [],
  }
}

type ListFilters = {
  max_price?: number
  min_price?: number
  min_beds?: number
  max_beds?: number
  neighborhood?: string
  borough?: string
  freshness_days?: 1 | 7 | 14 | 30
  min_score?: number
  pet_friendly?: boolean
  rent_stabilized?: boolean
  max_hpd_12mo?: number
}

async function tool_list_listings(input: {
  filters?: ListFilters
  sort?: 'score' | 'fresh' | 'price-asc'
  limit?: number
}): Promise<{ count: number; listings: ListingSummary[] }> {
  const filters = input.filters ?? {}
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20)
  const sort = input.sort ?? 'score'

  const all = await getRankedFeed({ freshnessDays: filters.freshness_days ?? 14 })

  let filtered = all
  if (filters.max_price != null)
    filtered = filtered.filter(
      (l) => l.price_monthly != null && l.price_monthly <= (filters.max_price as number),
    )
  if (filters.min_price != null)
    filtered = filtered.filter(
      (l) => l.price_monthly != null && l.price_monthly >= (filters.min_price as number),
    )
  if (filters.min_beds != null)
    filtered = filtered.filter(
      (l) => l.beds != null && Number(l.beds) >= (filters.min_beds as number),
    )
  if (filters.max_beds != null)
    filtered = filtered.filter(
      (l) => l.beds != null && Number(l.beds) <= (filters.max_beds as number),
    )
  if (filters.neighborhood) {
    const n = filters.neighborhood.toLowerCase()
    filtered = filtered.filter((l) => (l.neighborhood ?? '').toLowerCase().includes(n))
  }
  if (filters.borough) {
    filtered = filtered.filter((l) => l.borough === filters.borough)
  }
  if (filters.min_score != null)
    filtered = filtered.filter((l) => (l.score?.score ?? 0) >= (filters.min_score as number))
  if (filters.pet_friendly != null)
    filtered = filtered.filter((l) => l.pet_friendly === filters.pet_friendly)
  if (filters.rent_stabilized != null)
    filtered = filtered.filter((l) => (l.rent_stabilized ?? false) === filters.rent_stabilized)
  if (filters.max_hpd_12mo != null)
    filtered = filtered.filter((l) => (l.hpd_count_12mo ?? 0) <= (filters.max_hpd_12mo as number))

  if (sort === 'fresh') {
    filtered.sort((a, b) => (a.freshness_hours ?? Infinity) - (b.freshness_hours ?? Infinity))
  } else if (sort === 'price-asc') {
    filtered.sort((a, b) => (a.price_monthly ?? Infinity) - (b.price_monthly ?? Infinity))
  } else {
    filtered.sort((a, b) => (b.score?.score ?? 0) - (a.score?.score ?? 0))
  }

  const sliced = filtered.slice(0, limit)
  return { count: sliced.length, listings: sliced.map(summarize) }
}

async function tool_get_listing(input: { id: string }): Promise<
  { found: false } | { found: true; listing: ListingSummary & { description: string | null; address: string | null; contact: unknown; application: unknown; photos_count: number; vibe: unknown } }
> {
  const l = await getListing(input.id)
  if (!l) return { found: false }
  return {
    found: true,
    listing: {
      ...summarize(l),
      description: l.description,
      address: l.address,
      contact: l.contact ?? null,
      application: l.application ?? null,
      photos_count: (l.photos ?? []).length,
      vibe: l.vibe
        ? {
            nta_name: l.vibe.nta_name,
            walkability: l.vibe.walkability,
            cafes: l.vibe.cafes,
            greenness: l.vibe.greenness,
            nightlife: l.vibe.nightlife,
            noise: l.vibe.noise,
          }
        : null,
    },
  }
}

async function tool_save(input: { id: string; who: Saver }): Promise<{ ok: true; saved: true }> {
  await saveListing(input.id, input.who)
  return { ok: true, saved: true }
}

async function tool_unsave(input: { id: string; who: Saver }): Promise<{ ok: true; saved: false }> {
  await unsaveListing(input.id, input.who)
  return { ok: true, saved: false }
}

async function tool_get_saved(input: {
  who: 'inaan' | 'mekonnen' | 'both'
}): Promise<{ count: number; listings: ListingSummary[] }> {
  let rows: RankedListing[]
  if (input.who === 'both') rows = await getSavedIntersection()
  else rows = await getSavedFor(input.who)
  return { count: rows.length, listings: rows.map(summarize) }
}

async function tool_compare(input: { ids: string[] }): Promise<{
  count: number
  rows: Array<ListingSummary & { top_facts: string[] }>
  missing_ids: string[]
}> {
  const found: Array<ListingSummary & { top_facts: string[] }> = []
  const missing: string[] = []
  for (const id of input.ids.slice(0, 5)) {
    const l = await getListing(id)
    if (!l) {
      missing.push(id)
      continue
    }
    const facts = (l.score?.rationale_jsonb as { top_facts?: string[] } | null)?.top_facts ?? []
    found.push({ ...summarize(l), top_facts: facts })
  }
  return { count: found.length, rows: found, missing_ids: missing }
}

async function tool_get_profile_summary(): Promise<{
  ready: boolean
  joint: ReturnType<typeof mergeProfileConstraints> | null
  per_profile: Array<{
    slug: string
    name: string
    budget_min: number | null
    budget_max: number | null
    must_have: string[]
    deal_breakers: string[]
    nice_to_have: string[]
    preferred_areas: string[]
    vibes: Record<string, number>
    notes: string | null
  }>
}> {
  const profiles = await loadProfilesFromJson()
  if (profiles.length === 0) {
    return { ready: false, joint: null, per_profile: [] }
  }
  const joint = mergeProfileConstraints(profiles)
  const per_profile = profiles.map((p) => {
    const vibes: Record<string, number> = {}
    for (const [k, v] of Object.entries(p.vibes ?? {})) {
      if (typeof v === 'number') vibes[k] = v
    }
    return {
      slug: p.slug,
      name: p.name,
      budget_min: p.budget_min ?? null,
      budget_max: p.budget_max ?? null,
      must_have: p.must_have ?? [],
      deal_breakers: p.deal_breakers ?? [],
      nice_to_have: p.nice_to_have ?? [],
      preferred_areas: p.preferred_areas ?? [],
      vibes,
      notes: p.notes ?? null,
    }
  })
  return { ready: true, joint, per_profile }
}

async function tool_draft_email(input: {
  listing_id: string
  tone: 'casual' | 'formal' | 'enthusiastic'
  context?: string
}): Promise<
  | { ok: false; reason: string }
  | {
      ok: true
      to: string | null
      contact_name: string | null
      subject: string
      body: string
    }
> {
  const l = await getListing(input.listing_id)
  if (!l) return { ok: false, reason: 'listing not found' }
  const contact = l.contact ?? null
  const facts = (l.score?.rationale_jsonb as { top_facts?: string[] } | null)?.top_facts ?? []
  const fact = facts[0] ?? l.score?.headline ?? `${l.beds ?? ''}br at ${l.address ?? l.neighborhood ?? 'the unit'}`
  const subjectMap: Record<typeof input.tone, string> = {
    casual: `Interested in your ${l.neighborhood ?? ''} listing`,
    formal: `Inquiry: ${l.address ?? l.title}`,
    enthusiastic: `Saw your ${l.neighborhood ?? ''} place — would love a viewing`,
  }
  const greetingMap: Record<typeof input.tone, string> = {
    casual: contact?.name ? `Hi ${contact.name},` : 'Hi,',
    formal: contact?.name ? `Dear ${contact.name},` : 'Hello,',
    enthusiastic: contact?.name ? `Hey ${contact.name}!` : 'Hi there!',
  }
  const ctx = input.context ? ` ${input.context}` : ''
  const body = [
    greetingMap[input.tone],
    '',
    `We are Inaan and Mekonnen, looking to move in together in NYC. Your ${l.neighborhood ?? ''} listing caught our attention because: ${fact}.${ctx}`,
    '',
    `Could we set up a viewing this week? Evenings after 6pm or weekend mornings work best. Happy to share paystubs and references upfront.`,
    '',
    'Thanks,',
    'Inaan + Mekonnen',
  ].join('\n')
  return {
    ok: true,
    to: contact?.email ?? null,
    contact_name: contact?.name ?? null,
    subject: subjectMap[input.tone],
    body,
  }
}

async function runTool(name: string, input: unknown): Promise<unknown> {
  switch (name) {
    case 'list_listings':
      return tool_list_listings(input as Parameters<typeof tool_list_listings>[0])
    case 'get_listing':
      return tool_get_listing(input as { id: string })
    case 'save_listing': {
      const i = input as { id: string; who: string }
      if (!isSaver(i.who)) throw new Error("who must be 'inaan' or 'mekonnen'")
      return tool_save({ id: i.id, who: i.who })
    }
    case 'unsave_listing': {
      const i = input as { id: string; who: string }
      if (!isSaver(i.who)) throw new Error("who must be 'inaan' or 'mekonnen'")
      return tool_unsave({ id: i.id, who: i.who })
    }
    case 'get_saved':
      return tool_get_saved(input as { who: 'inaan' | 'mekonnen' | 'both' })
    case 'compare_listings':
      return tool_compare(input as { ids: string[] })
    case 'get_profile_summary':
      return tool_get_profile_summary()
    case 'draft_email':
      return tool_draft_email(input as Parameters<typeof tool_draft_email>[0])
    default:
      throw new Error(`unknown tool: ${name}`)
  }
}

/* ---------------------------- SSE helpers ------------------------------- */

function sseEncode(data: string, event?: string): string {
  const safe = data.replace(/\r\n|\r/g, '\n')
  const dataLines = safe
    .split('\n')
    .map((l) => `data: ${l}`)
    .join('\n')
  const head = event ? `event: ${event}\n` : ''
  return `${head}${dataLines}\n\n`
}

/* ---------------------------- message normalization --------------------- */

type IncomingMessage = z.infer<typeof ChatMessageSchema>

function toAnthropicMessages(msgs: IncomingMessage[]): Anthropic.MessageParam[] {
  return msgs.map((m) => {
    if (typeof m.content === 'string') {
      return { role: m.role, content: m.content }
    }
    // Already structured: pass through as-is. Types align with the SDK.
    return { role: m.role, content: m.content as unknown as Anthropic.ContentBlockParam[] }
  })
}

/* ---------------------------- POST handler ------------------------------ */

export async function POST(req: Request) {
  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return Response.json(
      { error: 'bad_request', message: err instanceof Error ? err.message : 'invalid body' },
      { status: 400 },
    )
  }

  const client = getAnthropic()
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function push(chunk: string) {
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          /* controller closed */
        }
      }

      const messages: Anthropic.MessageParam[] = toAnthropicMessages(body.messages)
      // Hard ceiling on agent loop to prevent runaways. 6 round-trips is plenty.
      const MAX_TURNS = 6

      try {
        for (let turn = 0; turn < MAX_TURNS; turn++) {
          const ms = client.messages.stream({
            model: MODELS.reason,
            max_tokens: 1500,
            temperature: 0.4,
            tools: TOOLS,
            system: [
              {
                type: 'text',
                text: SYSTEM_PROMPT,
                cache_control: { type: 'ephemeral' },
              },
            ] as Anthropic.TextBlockParam[],
            messages,
          })

          ms.on('text', (delta: string) => {
            push(sseEncode(delta))
          })

          ms.on('error', (err) => {
            console.error('[api/chat] stream error', err)
            push(sseEncode(`stream error: ${err.message}`, 'error'))
          })

          // Wait for the assistant message to land. The SDK gives us a Message
          // with one or more content blocks (text + maybe tool_use).
          const final = await ms.finalMessage()

          // Append the assistant's full message verbatim to the conversation.
          messages.push({ role: 'assistant', content: final.content as Anthropic.ContentBlockParam[] })

          // If the model is done (no tools), break.
          if (final.stop_reason !== 'tool_use') {
            break
          }

          // For each tool_use block, run the tool and collect results.
          const toolResults: Anthropic.ToolResultBlockParam[] = []
          for (const block of final.content) {
            if (block.type !== 'tool_use') continue

            // Tell the client a tool is running so the UI can show a chip.
            push(
              sseEncode(
                JSON.stringify({ id: block.id, name: block.name, input: block.input }),
                'tool_use',
              ),
            )

            let resultPayload: unknown
            let isError = false
            try {
              resultPayload = await runTool(block.name, block.input)
            } catch (err) {
              isError = true
              resultPayload = { error: err instanceof Error ? err.message : 'tool failed' }
              console.error('[api/chat] tool error', block.name, err)
            }

            const resultText =
              typeof resultPayload === 'string'
                ? resultPayload
                : JSON.stringify(resultPayload)

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultText,
              is_error: isError,
            })

            // Notify the client the tool finished. Send a small summary so the
            // listings rail can refresh from referenced ids — and ship a tiny
            // card payload for each id so the rail can render without a
            // round-trip back to the server.
            const refIds = extractListingIds(resultPayload)
            const cards = await buildRailCards(refIds)
            push(
              sseEncode(
                JSON.stringify({
                  id: block.id,
                  name: block.name,
                  ok: !isError,
                  ids: refIds,
                  cards,
                }),
                'tool_result',
              ),
            )
          }

          // Push tool_result back to the model on the next turn.
          messages.push({ role: 'user', content: toolResults })
        }
      } catch (err) {
        console.error('[api/chat] fatal', err)
        push(
          sseEncode(
            err instanceof Error ? err.message : 'unknown error',
            'error',
          ),
        )
      } finally {
        push(sseEncode('[DONE]', 'end'))
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }
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

type RailCard = {
  id: string
  title: string
  score: number
  headline: string
  price_monthly: number | null
  beds: string | null
  neighborhood: string | null
  borough: string | null
  photo: string | null
}

async function buildRailCards(ids: string[]): Promise<RailCard[]> {
  const out: RailCard[] = []
  for (const id of ids) {
    try {
      const l = await getListing(id)
      if (!l) continue
      out.push({
        id: l.id,
        title: l.title,
        score: l.score?.score ?? 0,
        headline: l.score?.headline ?? l.title,
        price_monthly: l.price_monthly ?? null,
        beds: l.beds ?? null,
        neighborhood: l.neighborhood ?? null,
        borough: l.borough ?? null,
        photo: (l.photos ?? [])[0] ?? null,
      })
    } catch {
      /* skip */
    }
  }
  return out
}

/**
 * Pull listing UUIDs out of arbitrary tool-result payloads so the client can
 * refresh the listings rail without re-parsing the model's text.
 */
function extractListingIds(payload: unknown): string[] {
  const ids = new Set<string>()
  function walk(v: unknown) {
    if (!v) return
    if (typeof v === 'string') {
      // UUID v4 shape; loose match.
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
        ids.add(v)
      }
      return
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (typeof v === 'object') {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === 'id' && typeof x === 'string') {
          if (/^[0-9a-f-]{30,}$/i.test(x)) ids.add(x)
        } else if (k === 'ids' && Array.isArray(x)) {
          for (const s of x) if (typeof s === 'string') ids.add(s)
        } else if (k === 'listing_id' && typeof x === 'string') {
          ids.add(x)
        } else {
          walk(x)
        }
      }
    }
  }
  walk(payload)
  return [...ids]
}
