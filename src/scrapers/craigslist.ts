/**
 * Craigslist scraper for the 5 NYC borough subdomains.
 *
 * Strategy:
 *   1. Hit each `.craigslist.org/search/apa` listings page with a Safari UA.
 *   2. Parse the search HTML for title / price / URL / posted-at / neighborhood.
 *   3. For each result URL, fetch the detail page (rate-limited per host) and
 *      extract photos, full description, contact relay email + phone if present.
 *
 * Notes:
 *   - The RSS endpoint (?format=rss) returns 403 with browser UA; HTML works fine.
 *   - Throttled to ≥3s per host via `throttledFetch`.
 *   - Failures of one borough or one detail page must not poison the rest.
 */

import * as cheerio from 'cheerio'
import pLimit from 'p-limit'
import type { NewListing } from '@/types'
import { canonicalize } from '@/lib/neighborhoods'
import {
  absoluteUrl,
  clBorough,
  extractEmail,
  extractPhone,
  logScrapeError,
  parseBeds,
  parsePrice,
  parseBrokerFee,
  parseFee,
  throttledFetch,
} from './_util'

const SUBDOMAINS = ['newyork', 'brooklyn', 'queens', 'bronx', 'statenisland'] as const
type Subdomain = (typeof SUBDOMAINS)[number]

/**
 * Find the JSON literal that follows `imgList = ` (or `var imgList = `) by
 * walking brackets to find the matching close. Returns the JSON substring
 * (including the outer brackets) or null if no balanced array could be
 * located.
 *
 * The naive `\[[^\]]+\]` regex breaks on multi-photo CL listings: each photo
 * object is `{"url": "https://...", "imgid": "..."}` and a 12-photo array is
 * 12 such objects, with `]` characters appearing inside URLs (encoded) and
 * across object boundaries. We track bracket depth to find the right close.
 */
function extractImgListJson(src: string): string | null {
  const re = /imgList\s*=\s*\[/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1 // points at the opening `[`
    let depth = 0
    let inStr = false
    let strCh = '"'
    let escaped = false
    for (let i = start; i < src.length; i++) {
      const ch = src[i]
      if (inStr) {
        if (escaped) {
          escaped = false
        } else if (ch === '\\') {
          escaped = true
        } else if (ch === strCh) {
          inStr = false
        }
        continue
      }
      if (ch === '"' || ch === "'") {
        inStr = true
        strCh = ch
        continue
      }
      if (ch === '[') depth += 1
      else if (ch === ']') {
        depth -= 1
        if (depth === 0) {
          return src.slice(start, i + 1)
        }
      }
    }
  }
  return null
}

/** Maximum number of detail pages fetched per borough per run (safety cap). */
const MAX_DETAILS_PER_BOROUGH = 40

type SearchHit = {
  subdomain: Subdomain
  url: string
  title: string
  price: number | null
  beds: string | null
  neighborhood: string | null
  posted_at: Date | null
}

/**
 * Parse a single Craigslist `/search/apa` HTML page into search-result hits.
 * CL has changed markup over time; we tolerate both old (`li.result-row`) and
 * the modern grid (`li.cl-static-search-result` / `li.cl-search-result`).
 */
function parseSearchHtml(html: string, subdomain: Subdomain): SearchHit[] {
  const $ = cheerio.load(html)
  const hits: SearchHit[] = []

  // Modern markup: each result is an <li class="cl-search-result"> with an <a> wrapping
  // a title + price + meta line.
  $('li.cl-search-result, li.cl-static-search-result, li.result-row').each((_, el) => {
    const $el = $(el)
    const $a = $el.find('a').first()
    const href = $a.attr('href')
    if (!href) return
    const url = absoluteUrl(href, `https://${subdomain}.craigslist.org/`)
    if (!url || !/\/apa\//.test(url)) return

    const title =
      $el.find('.title, .result-title, .post-title, .title-blob a').first().text().trim() ||
      $a.text().trim()
    if (!title) return

    const priceText =
      $el.find('.priceinfo, .price, .result-price').first().text().trim() ||
      ($el.text().match(/\$\s?\d[\d,]*/)?.[0] ?? '')
    const price = parsePrice(priceText)

    const meta = $el.find('.meta, .result-meta, .housing').text() || $el.text()
    const beds = parseBeds(`${title} ${meta}`)

    const neighborhood =
      $el.find('.location, .result-hood').first().text().trim().replace(/^[\s(]+|[\s)]+$/g, '') ||
      null

    const postedAttr =
      $el.find('time').attr('datetime') ?? $el.find('time.timeago').attr('datetime')
    let posted: Date | null = null
    if (postedAttr) {
      const d = new Date(postedAttr)
      if (!Number.isNaN(d.getTime())) posted = d
    }

    hits.push({
      subdomain,
      url,
      title,
      price,
      beds,
      neighborhood,
      posted_at: posted,
    })
  })

  return hits
}

/**
 * Fetch + parse a single CL detail page into a NewListing.
 * Skips if the listing has been deleted/expired.
 */
async function parseDetail(hit: SearchHit): Promise<NewListing | null> {
  const res = await throttledFetch(hit.url)
  if (res.status === 404 || res.status === 410) return null
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${hit.url}`)
  const html = await res.text()
  if (/this posting has been deleted|posting has expired/i.test(html)) return null

  const $ = cheerio.load(html)

  // Title: prefer #titletextonly, fall back to og:title
  const title =
    $('#titletextonly').text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    hit.title

  // Description: clean #postingbody, dropping QR / "QR Code Link" header
  $('#postingbody .print-information, #postingbody .print-qrcode-container').remove()
  const description = $('#postingbody').text().replace(/^\s*QR Code Link to This Post\s*/i, '').trim() ||
    $('meta[property="og:description"]').attr('content')?.trim() ||
    null

  // Photos: gallery uses .swipe img / .gallery-image. og:image is fallback for the cover.
  const photoSet = new Set<string>()
  $('.swipe img, .gallery-image, img.gallery-image, #thumbs img, .iw img').each((_, el) => {
    const src =
      $(el).attr('data-imgid') ||
      $(el).attr('src') ||
      $(el).attr('data-src')
    const abs = absoluteUrl(src, hit.url)
    if (abs) photoSet.add(abs)
  })
  // CL also embeds full-size URLs in `imgList` JSON in inline <script>. Try to lift them.
  // The previous regex `/imgList\s*=\s*(\[[^\]]+\])/` was brittle: `[^\]]+` is
  // greedy-but-bracket-shy, so on multi-photo arrays it matched only up to the
  // FIRST `]` (e.g. inside the URL itself or across object boundaries),
  // truncating the JSON and tossing the parse. We replace with a balanced-
  // bracket walker: find `imgList = [`, then walk the string tracking depth,
  // returning the slice ending at the matching outer `]`. This covers the
  // 12-photo arrays we routinely see on Brooklyn listings without breaking
  // on nested brackets in URL-encoded params.
  const inlineScripts = $('script')
    .map((_, el) => $(el).html() ?? '')
    .get()
    .join('\n')
  const imgListBalanced = extractImgListJson(inlineScripts)
  if (imgListBalanced) {
    try {
      const arr = JSON.parse(imgListBalanced) as Array<{
        url?: string
        imgid?: string
      }>
      for (const it of arr) {
        if (it?.url) photoSet.add(it.url)
        // Some CL forks emit `imgid` instead of `url`; reconstruct the standard
        // 600x450 thumb URL when only an id is present.
        else if (typeof it?.imgid === 'string' && /^[0-9A-Za-z]+_/.test(it.imgid)) {
          photoSet.add(`https://images.craigslist.org/${it.imgid}_600x450.jpg`)
        }
      }
    } catch {
      // ignore — best effort
    }
  }
  // As a final safety net, scan the inline script blob for any
  // `https://images.craigslist.org/...` URLs the parser missed.
  for (const m of inlineScripts.matchAll(
    /https?:\/\/images\.craigslist\.org\/[^\s"'<>]+\.(?:jpe?g|png|webp)/gi,
  )) {
    photoSet.add(m[0])
  }
  const ogImg = $('meta[property="og:image"]').attr('content')
  if (ogImg && photoSet.size === 0) {
    const abs = absoluteUrl(ogImg, hit.url)
    if (abs) photoSet.add(abs)
  }
  const photos = [...photoSet]

  // posted_at: time.timeago[datetime]
  let posted_at = hit.posted_at
  const dt = $('time.timeago').attr('datetime') ?? $('time').attr('datetime')
  if (dt) {
    const d = new Date(dt)
    if (!Number.isNaN(d.getTime())) posted_at = d
  }

  // Attribute table: bedrooms / sqft / available / housing line
  const attrs = $('.attrgroup, p.attrgroup').text()
  const beds = hit.beds ?? parseBeds(`${title} ${attrs}`)
  const sqftMatch = attrs.match(/(\d{3,5})\s*ft/i)
  const sqft = sqftMatch ? parseInt(sqftMatch[1], 10) : null

  // lat/lng from the small Google maps block, if present
  const mapDiv = $('#map')
  const lat = mapDiv.attr('data-latitude')
  const lng = mapDiv.attr('data-longitude')

  // Address (CL rarely has it explicitly; sometimes div.mapaddress)
  const address = $('.mapaddress').text().trim() || null

  // Neighborhood: search-result hood, or from #titletextonly's location parens.
  // Run through `canonicalize` so the DB column converges to one form per area
  // ("Bedford-Stuyvesant" not "Bed-Stuy" / "BedStuy" / "Bedford Stuy").
  const rawNbhd =
    hit.neighborhood ||
    $('.postingtitletext small').text().replace(/[()]/g, '').trim() ||
    null
  const neighborhood = canonicalize(rawNbhd) ?? rawNbhd

  // Reply email (CL relay) — visible reply page lives at /reply/<host>/apa/<id>; the
  // detail page exposes the relay address in JSON or in the reply <a>.
  const replyHref = $('.reply-button-row a, button.reply-button').attr('href') ?? ''
  const relayMatch =
    description?.match(/[\w.+-]+@hous\.craigslist\.org/) ??
    inlineScripts.match(/[\w.+-]+@hous\.craigslist\.org/)
  const relayEmail = relayMatch ? relayMatch[0] : extractEmail(description ?? '')
  const phone = extractPhone(description ?? '')

  // Application + broker-fee parse
  const applicationFee = description ? parseFee(description) : null
  const brokerFee = description ? parseBrokerFee(description) : {}
  const application: NewListing['application'] | undefined =
    applicationFee != null || Object.keys(brokerFee).length > 0
      ? {
          fee: applicationFee ?? undefined,
          broker_fee_pct: brokerFee.broker_fee_pct,
          broker_fee_text: brokerFee.broker_fee_text,
        }
      : undefined

  return {
    source: 'craigslist',
    source_url: hit.url,
    title,
    description,
    price_monthly: hit.price ?? null,
    beds,
    sqft,
    photos,
    address,
    neighborhood,
    borough: clBorough(hit.subdomain),
    lat: lat ? parseFloat(lat) : null,
    lng: lng ? parseFloat(lng) : null,
    contact: {
      email: relayEmail,
      phone,
      preferred_method: relayEmail ? 'email' : phone ? 'phone' : undefined,
    },
    application,
    posted_at: posted_at ?? null,
    is_active: true,
    raw: { search_hit: hit, reply_href: replyHref },
  }
}

/** Top-level fetcher for one borough. Errors on the search page → empty list. */
async function fetchBorough(subdomain: Subdomain): Promise<NewListing[]> {
  const searchUrl = `https://${subdomain}.craigslist.org/search/apa`
  let hits: SearchHit[] = []
  try {
    const res = await throttledFetch(searchUrl)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    hits = parseSearchHtml(html, subdomain).slice(0, MAX_DETAILS_PER_BOROUGH)
  } catch (err) {
    logScrapeError('craigslist', searchUrl, err)
    return []
  }

  // Fetch details serially per borough — `throttledFetch` already gates by host
  // (each borough is its own host so we could parallelize across boroughs, but
  // detail pages all live on the same subdomain so 1-at-a-time is required).
  const out: NewListing[] = []
  for (const hit of hits) {
    try {
      const listing = await parseDetail(hit)
      if (listing) out.push(listing)
    } catch (err) {
      logScrapeError('craigslist', hit.url, err)
    }
  }
  return out
}

/** Orchestrator. Boroughs run in parallel (different hosts), details serial per host. */
export async function fetchCraigslist(): Promise<NewListing[]> {
  const limit = pLimit(SUBDOMAINS.length) // each borough is a different subdomain
  const results = await Promise.all(
    SUBDOMAINS.map((sd) => limit(() => fetchBorough(sd)))
  )
  return results.flat()
}
