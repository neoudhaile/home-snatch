/**
 * Reddit scraper for r/NYCapartments and r/AskNYC.
 *
 * The signal:noise ratio on these subs is ~30/70. We classify each post with
 * Haiku — "is this an offer (someone has a unit) vs a request / discussion?".
 * If it's an offer, we ask Haiku to also extract listing fields from the post
 * body and embedded links. We capture i.redd.it / imgur image URLs verbatim.
 *
 * Endpoint: `https://www.reddit.com/r/<sub>/new.json?limit=100`. No auth needed
 * for read-only public listings; a browser UA is enough.
 */

import type Anthropic from '@anthropic-ai/sdk'
import { getAnthropic, MODELS } from '@/lib/anthropic'
import type { NewListing } from '@/types'
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

const SUBS = ['NYCapartments', 'AskNYC'] as const

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

async function fetchSubreddit(sub: string): Promise<RedditPost[]> {
  const url = `https://www.reddit.com/r/${sub}/new.json?limit=100`
  try {
    const res = await throttledFetch(url, {
      headers: { Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = (await res.json()) as RedditListingResponse
    return (json.data?.children ?? []).map((c) => c.data).filter(Boolean)
  } catch (err) {
    logScrapeError('reddit', url, err)
    return []
  }
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
    neighborhood: c.neighborhood ?? null,
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
    raw: { reddit_id: post.id, subreddit: post.subreddit, classification: c },
  }
}

export async function fetchReddit(): Promise<NewListing[]> {
  const all = (await Promise.all(SUBS.map((s) => fetchSubreddit(s)))).flat()

  const out: NewListing[] = []
  // Classify serially to keep Haiku spend bounded; could batch later.
  for (const post of all) {
    // Cheap pre-filter: skip obvious ISO posts before paying for a Haiku call.
    const t = post.title.toLowerCase()
    if (/\b(iso|looking|advice|need help|recommend|question)\b/.test(t)) continue
    if (post.selftext.length < 60 && !post.url_overridden_by_dest) continue

    const cls = await classifyPost(post)
    if (!cls || !cls.is_offer) continue
    out.push(buildListing(post, cls))
  }
  return out
}
