/**
 * Extract Craigslist relay emails via Apify's `scraper-mind/craigslist-email-scraper`
 * actor. This is the purpose-built actor for the exact thing CL hardened against
 * with the sapi.craigslist.org JS handshake.
 *
 * Run: source .env.local; npx tsx scripts/extract-cl-emails-apify.ts
 *
 * Requires: APIFY_TOKEN in .env.local (get from https://apify.com → Settings → API).
 *
 * Output: scripts/cl-inquiries.json — array of {url, postId, title, price,
 * neighborhood, email}.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MD_PATH = resolve(process.cwd(), 'nyc_apartments.md')
const OUT_PATH = resolve(process.cwd(), 'scripts/cl-inquiries.json')
const ACTOR_ID = 'memo23~craigslist-scraper'

type ListingMeta = {
  url: string
  postId: string
  title: string
  price: string | null
  neighborhood: string | null
}

function parseListings(md: string): ListingMeta[] {
  const lines = md.split('\n')
  const out: ListingMeta[] = []
  let currentNeighborhood: string | null = null
  let pendingTitle: string | null = null
  let pendingPrice: string | null = null

  for (const line of lines) {
    const nMatch = line.match(/^### ([^—]+) —/)
    if (nMatch) currentNeighborhood = nMatch[1].trim()

    const titleMatch = line.match(/^\*\*\d+\.\s+(.+?)\*\*\s+—\s+(\$[\d,]+\/mo)/)
    if (titleMatch) {
      pendingTitle = titleMatch[1].trim()
      pendingPrice = titleMatch[2]
    }

    const urlMatch = line.match(/\((https:\/\/[a-z]+\.craigslist\.org\/[^)]+\.html)\)/)
    if (urlMatch && pendingTitle) {
      const url = urlMatch[1]
      const postIdMatch = url.match(/\/(\d+)\.html$/)
      if (postIdMatch) {
        out.push({
          url,
          postId: postIdMatch[1],
          title: pendingTitle,
          price: pendingPrice,
          neighborhood: currentNeighborhood,
        })
      }
      pendingTitle = null
      pendingPrice = null
    }
  }
  const seen = new Set<string>()
  return out.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)))
}

async function runActor(urls: string[]): Promise<unknown[]> {
  const token = process.env.APIFY_TOKEN
  if (!token) throw new Error('APIFY_TOKEN not set in .env.local')

  // Try two common input shapes — actor docs aren't loaded but these cover ~90%
  // of community actors. If actor expects a different shape, the run will succeed
  // with empty output and we'll see it in the dataset.
  const input = {
    startUrls: urls.map((url) => ({ url })),
    maxItems: urls.length,
    proxy: { useApifyProxy: true, apifyProxyGroups: ['RESIDENTIAL'] },
  }

  const endpoint = `https://api.apify.com/v2/acts/${ACTOR_ID}/run-sync-get-dataset-items?token=${token}&timeout=300`
  console.log(`[apify] POST ${ACTOR_ID} with ${urls.length} URLs (this can take 1-3 min)...`)
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`Apify HTTP ${res.status}: ${txt.slice(0, 500)}`)
  }
  const items = (await res.json()) as unknown[]
  console.log(`[apify] received ${items.length} items`)
  return items
}

function pickEmailFromItem(item: any): string | null {
  if (!item || typeof item !== 'object') return null
  // Try common field names. Falls back to scanning all string fields for relay pattern.
  for (const key of ['email', 'replyEmail', 'relay_email', 'reply_email', 'contactEmail', 'contact_email']) {
    const v = item[key]
    if (typeof v === 'string' && v.includes('@')) return v
  }
  const blob = JSON.stringify(item)
  const m = blob.match(/[a-zA-Z0-9._%+-]+@reply\.craigslist\.org/)
  return m ? m[0] : null
}

function pickUrlFromItem(item: any): string | null {
  if (!item || typeof item !== 'object') return null
  for (const key of ['url', 'postUrl', 'listingUrl', 'sourceUrl']) {
    const v = item[key]
    if (typeof v === 'string' && v.includes('craigslist.org')) return v
  }
  return null
}

async function main() {
  const md = readFileSync(MD_PATH, 'utf8')
  const listings = parseListings(md)
  console.log(`[cl-emails] parsed ${listings.length} unique Craigslist listings`)

  const items = await runActor(listings.map((l) => l.url))

  // Save raw output for debugging in case our field-name guesses miss.
  writeFileSync(resolve(process.cwd(), 'scripts/cl-apify-raw.json'), JSON.stringify(items, null, 2))

  // Index returned items by URL when possible, else fall back to positional.
  const byUrl = new Map<string, any>()
  items.forEach((it: any, i) => {
    const u = pickUrlFromItem(it)
    if (u) byUrl.set(u, it)
  })

  const results = listings.map((l, i) => {
    const item = byUrl.get(l.url) ?? items[i] ?? null
    const email = pickEmailFromItem(item)
    return { ...l, email, _matched: item ? true : false }
  })

  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2))
  const ok = results.filter((r) => r.email).length
  console.log(`[cl-emails] wrote ${OUT_PATH} — ${ok}/${results.length} with email`)
  if (ok === 0) {
    console.log('[cl-emails] ⚠ no emails extracted — inspect scripts/cl-apify-raw.json to see actor output shape')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
