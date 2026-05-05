/**
 * Reddit scraper.
 *
 * Coverage (16 subs, prioritized — quality first, breadth second):
 *
 *   General NYC:        NYCapartments, AskNYC, HousingNYC
 *   Per-borough:        Brooklyn, Manhattan, Queens
 *   Neighborhood-deep:  Williamsburg, Bushwick, CrownHeights, BedStuy,
 *                       ParkSlope, Astoria, LongIslandCity, UpperEastSide,
 *                       UpperWestSide
 *   Student sublets:    Columbia, NYU, CUNY  (frequent fresh sublet posts mid-semester)
 *
 * Per sub we hit two endpoints:
 *   - `/new.json?limit=50` — the firehose of newest posts (hits everything,
 *     including off-topic; we filter aggressively before paying for a Haiku call).
 *   - `/search.json?q=apartment%20OR%20rent&restrict_sr=on&sort=new&limit=50` —
 *     keyword-targeted; lower volume but higher signal:noise.
 *
 * Pre-filter (cheap regex, no LLM) drops obvious ISO / advice / discussion posts
 * before we spend Anthropic credit. Classification + extraction then runs through
 * Haiku with a `p-limit(4)` cap so a 12-sub sweep doesn't blow up the bill.
 *
 * Tagging: every result carries `raw.subreddit` + `raw.permalink` so we can trace
 * which sub a hit came from in admin / debug output.
 *
 * Throttling: `throttledFetch` already gates ≥3s per host (`reddit.com` is one
 * host across all subs, so requests sequence naturally — well under Reddit's
 * ~60-req/min anonymous JSON cap).
 */

import type Anthropic from '@anthropic-ai/sdk'
import pLimit from 'p-limit'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import { canonicalize } from '@/lib/neighborhoods'
import type { NewListing } from '@/types'
import {
  getCachedClassifications,
  upsertClassifications,
} from '@/lib/reddit-cache'
import {
  extractEmail,
  extractImageUrls,
  extractPhone,
  logScrapeError,
  parseBeds,
  parseBrokerFee,
  parseFee,
  parsePrice,
  throttledFetch,
} from './_util'

/**
 * Subs we pull from. Ordering matters only for log readability — every sub is
 * fetched, classified, and merged into one stream.
 */
const SUBS = [
  // General NYC
  'NYCapartments',
  'AskNYC',
  'HousingNYC',
  // Boroughs
  'Brooklyn',
  'Manhattan',
  'Queens',
  // Neighborhoods (Brooklyn-heavy; this is where the rooms tend to post)
  'Williamsburg',
  'Bushwick',
  'CrownHeights',
  'BedStuy',
  'ParkSlope',
  'Astoria',
  'LongIslandCity',
  'UpperEastSide',
  'UpperWestSide',
  // Student sublets — frequently fresh inventory mid-semester
  'Columbia',
  'NYU',
  'CUNY',
] as const

type RedditPost = {
  id: string
  permalink: string
  url: string
  title: string
  selftext: string
  created_utc: number
  author: string
  subreddit: string
  preview?: { images?: Array<{ source?: { url?: string } }> }
  url_overridden_by_dest?: string
  is_self: boolean
}

type RedditListingResponse = {
  data: { children: Array<{ data: RedditPost }> }
}

/**
 * Fetch one Reddit JSON endpoint and return raw posts. Errors → empty array
 * (we never throw out of a single sub — one bad sub must not block the rest).
 */
async function fetchEndpoint(
  url: string,
  source: string,
): Promise<RedditPost[]> {
  try {
    const res = await throttledFetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as RedditListingResponse
    return (json.data?.children ?? []).map((c) => c.data).filter(Boolean)
  } catch (err) {
    logScrapeError(`reddit:${source}`, url, err)
    return []
  }
}

/**
 * Pull both `/new.json` and `/search.json?q=apartment OR rent` for a sub. Dedup
 * by post id at the source. Returns the merged stream.
 */
async function fetchSubreddit(sub: string): Promise<RedditPost[]> {
  const newUrl = `https://www.reddit.com/r/${sub}/new.json?limit=50`
  const searchUrl = `https://www.reddit.com/r/${sub}/search.json?q=apartment%20OR%20rent%20OR%20sublet%20OR%20lease&sort=new&restrict_sr=on&limit=50`
  const [a, b] = await Promise.all([
    fetchEndpoint(newUrl, sub),
    fetchEndpoint(searchUrl, sub),
  ])
  const seen = new Set<string>()
  const out: RedditPost[] = []
  for (const p of [...a, ...b]) {
    if (!p?.id || seen.has(p.id)) continue
    seen.add(p.id)
    out.push(p)
  }
  return out
}

type Classification = {
  is_offer: boolean
  price_monthly: number | null
  beds: number | null
  neighborhood: string | null
  borough: string | null
  address: string | null
  available_date: string | null
  amenities: string[]
  application_notes: string | null
  is_no_fee: boolean
  contact_phone: string | null
  contact_email: string | null
}

const CLASSIFY_TOOL: Anthropic.Tool = {
  name: 'classify_post',
  description:
    'Classify a Reddit post and extract apartment listing details ONLY if the post is offering a unit (not asking for one, not asking a general question, not a discussion).',
  input_schema: {
    type: 'object',
    properties: {
      is_offer: {
        type: 'boolean',
        description:
          'True if the post offers a specific apartment for rent (someone is the lister or knows of a unit). False for ISO/looking-for posts, scams, general questions.',
      },
      price_monthly: { type: ['integer', 'null'] },
      beds: { type: ['number', 'null'] },
      neighborhood: { type: ['string', 'null'] },
      borough: { type: ['string', 'null'] },
      address: { type: ['string', 'null'] },
      available_date: {
        type: ['string', 'null'],
        description: 'ISO 8601 date if mentioned, else null.',
      },
      amenities: { type: 'array', items: { type: 'string' } },
      application_notes: { type: ['string', 'null'] },
      is_no_fee: { type: 'boolean' },
      contact_phone: { type: ['string', 'null'] },
      contact_email: { type: ['string', 'null'] },
    },
    required: ['is_offer', 'amenities', 'is_no_fee'],
  },
}

async function classifyPost(post: RedditPost): Promise<Classification | null> {
  const anthropic = getAnthropic()
  const text = `Title: ${post.title}\n\nBody:\n${post.selftext || '(no body)'}\n\nAuthor: u/${post.author}\nSubreddit: r/${post.subreddit}`

  try {
    const resp = await anthropic.messages.create({
      model: MODELS.extract,
      max_tokens: 600,
      tools: [CLASSIFY_TOOL],
      tool_choice: { type: 'tool', name: 'classify_post' },
      system: [
        {
          type: 'text',
          text:
            'You classify Reddit posts from NYC apartment subs. ONLY mark is_offer=true when the poster is offering a specific unit for rent. ISO ("in search of"), "looking for advice", scam-warnings, and general questions are NOT offers. When in doubt, return is_offer=false. Do not fabricate fields — return null when unstated.',
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [{ role: 'user', content: text }],
    })
    const block = resp.content.find((c) => c.type === 'tool_use')
    if (!block || block.type !== 'tool_use') return null
    return block.input as Classification
  } catch (err) {
    logScrapeError('reddit', post.permalink, err)
    return null
  }
}

/** Pull image URLs from a Reddit post (preview, link target, body text). */
function postPhotos(post: RedditPost): string[] {
  const set = new Set<string>()
  const dest = post.url_overridden_by_dest || post.url
  if (dest && /\.(?:png|jpe?g|webp|gif)(?:\?|$)/i.test(dest)) set.add(dest)
  if (dest && /^https?:\/\/(?:i\.redd\.it|i\.imgur\.com)\//.test(dest)) set.add(dest)
  for (const im of post.preview?.images ?? []) {
    const raw = im?.source?.url
    if (raw) {
      // Reddit preview URLs are HTML-entity-encoded; decode `&amp;`.
      set.add(raw.replace(/&amp;/g, '&'))
    }
  }
  for (const u of extractImageUrls(post.selftext || '')) set.add(u)
  return [...set]
}

function buildListing(post: RedditPost, c: Classification): NewListing {
  const permalink = `https://www.reddit.com${post.permalink}`
  const fullText = `${post.title}\n${post.selftext}`

  // Best-effort lift if the model missed numeric fields.
  const price = c.price_monthly ?? parsePrice(fullText)
  const beds =
    c.beds != null ? c.beds.toString() : parseBeds(post.title) ?? parseBeds(post.selftext)
  const fee = parseFee(post.selftext || '')
  const broker = parseBrokerFee(post.selftext || '')
  const phone = c.contact_phone || extractPhone(post.selftext || '')
  const email = c.contact_email || extractEmail(post.selftext || '')

  return {
    source: 'reddit',
    source_url: permalink,
    title: post.title,
    description: post.selftext || null,
    price_monthly: price ?? null,
    beds,
    photos: postPhotos(post),
    address: c.address ?? null,
    // Canonicalize at ingest: e.g. Haiku says "Bed-Stuy" → DB stores
    // "Bedford-Stuyvesant". Falls through to the raw model output if the
    // alias map doesn't recognize it.
    neighborhood: canonicalize(c.neighborhood) ?? c.neighborhood ?? null,
    borough: c.borough ?? null,
    available_date: c.available_date ? new Date(c.available_date) : null,
    amenities: c.amenities ?? [],
    contact: {
      phone: phone ?? undefined,
      email: email ?? undefined,
      preferred_method: email ? 'email' : phone ? 'phone' : undefined,
    },
    application: {
      fee: fee ?? undefined,
      broker_fee_pct: c.is_no_fee ? 0 : broker.broker_fee_pct,
      broker_fee_text: c.is_no_fee ? 'no fee' : broker.broker_fee_text,
      notes: c.application_notes ?? undefined,
    },
    posted_at: new Date(post.created_utc * 1000),
    is_active: true,
    raw: {
      reddit_id: post.id,
      subreddit: post.subreddit,
      permalink,
      classification: c,
    },
  }
}

/**
 * Cheap regex to drop ISO / discussion / advice posts before paying for Haiku.
 * Returns true if the post should be SKIPPED (i.e. it looks like noise).
 *
 * Patterns covered:
 *   - "ISO", "in search of"
 *   - "looking for", "anyone tried", "anyone know", "anyone have"
 *   - "advice", "need help", "recommend", "suggestion", "question", "review"
 *   - "is X normal?", "thoughts on?", "opinions"
 *   - "moving to NYC", "is it worth", "how do I"
 *   - "scam", "warning"
 *   - "rant", "vent"
 */
function looksLikeNoise(post: RedditPost): boolean {
  const t = post.title.toLowerCase()
  if (
    /\b(iso|in search of|looking for|anyone tried|anyone know|anyone have|advice|need help|recommend|suggestion|question|review|is it normal|thoughts on|opinions on|moving to nyc|how do i|how do you|is it worth|scam|warning|rant|vent|help me|wanted)\b/.test(
      t,
    )
  ) {
    return true
  }
  // Empty/near-empty self-posts with no link target are almost always discussion.
  if (post.selftext.length < 60 && !post.url_overridden_by_dest) return true
  return false
}

export async function fetchReddit(): Promise<NewListing[]> {
  // Fetch every sub in parallel — `throttledFetch` already gates per-host so
  // they sequence naturally on `reddit.com` (~1.5s between requests, well
  // under Reddit's ~60/min anonymous JSON cap).
  const all = (await Promise.all(SUBS.map((s) => fetchSubreddit(s)))).flat()

  // Dedupe across subs by post id (cross-posts show up in multiple subs).
  const byId = new Map<string, RedditPost>()
  for (const p of all) {
    if (!p?.id) continue
    if (!byId.has(p.id)) byId.set(p.id, p)
  }
  const candidates = [...byId.values()].filter((p) => !looksLikeNoise(p))

  // ---- Classification-cache pre-fetch -----------------------------------
  // Pull existing classifications in ONE query, skip Haiku for hits, classify
  // only the misses. ~80% of /new posts repeat across cron runs so this drops
  // the Anthropic spend per scrape pass dramatically once the cache is warm.
  const candidateIds = candidates.map((p) => p.id).filter(Boolean)
  const cached = await getCachedClassifications<Classification>(candidateIds)
  const hits = candidates.filter((p) => cached.has(p.id))
  const misses = candidates.filter((p) => !cached.has(p.id))
  console.log(
    `[reddit] cache: ${hits.length} hit / ${misses.length} miss / ${candidates.length} candidates`,
  )

  // Cap concurrent Haiku classification calls to keep Anthropic spend bounded.
  const limit = pLimit(4)
  const newlyClassified: Array<{ post_id: string; classification: Classification }> = []

  const settled = await Promise.allSettled(
    candidates.map((post) =>
      limit(async () => {
        let cls: Classification | null
        const cachedCls = cached.get(post.id)
        if (cachedCls) {
          cls = cachedCls
        } else {
          cls = await classifyPost(post)
          if (cls) {
            // Defer the upsert to one batch insert at the end so we don't
            // open N connections.
            newlyClassified.push({ post_id: post.id, classification: cls })
          }
        }
        if (!cls || !cls.is_offer) return null
        return buildListing(post, cls)
      }),
    ),
  )

  // Single batch insert of all newly-classified posts.
  if (newlyClassified.length > 0) {
    await upsertClassifications(newlyClassified)
  }

  const out: NewListing[] = []
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value) out.push(r.value)
  }
  return out
}
