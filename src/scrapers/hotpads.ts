/**
 * HotPads direct scraper.
 *
 * Strategy: probe https://hotpads.com/new-york-ny/apartments-for-rent with a
 * Safari UA. HotPads is a Zillow Group property and increasingly behind the
 * same Akamai stack — direct fetch may or may not work on any given day. If
 * blocked, we fall through to the Apify path (`epctex~hotpads-scraper`).
 *
 * The page is React-rendered but ships an initial state JSON in `<script
 * id="__NEXT_DATA__">` (Next.js) on some routes; on others it's a plain
 * server-rendered card list. We try Next-data first, then fall back to HTML
 * card parsing.
 *
 * Output: title / price / URL / cover photo / neighborhood. We don't fetch
 * detail pages — they're behind a heavier rendering path. The search-card
 * data is enough to surface in the feed.
 */

import * as cheerio from 'cheerio'
import type { NewListing } from '@/types'
import {
  absoluteUrl,
  logScrapeError,
  parseBeds,
  parsePrice,
  throttledFetch,
} from './_util'

const ROOT = 'https://hotpads.com'

const PROBES = [
  `${ROOT}/new-york-ny/apartments-for-rent`,
  `${ROOT}/manhattan-ny/apartments-for-rent`,
  `${ROOT}/brooklyn-ny/apartments-for-rent`,
  `${ROOT}/queens-ny/apartments-for-rent`,
] as const

function isBlocked(html: string): boolean {
  if (html.length < 800) return true
  return /access denied|akamai|reference\s*#\s*\d|just a moment/i.test(html)
}

type NextData = {
  props?: {
    pageProps?: {
      listings?: unknown[]
      results?: unknown[]
      initialState?: { search?: { results?: unknown[] } }
    }
  }
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return null
}

function pickNum(o: Record<string, unknown>, ...keys: string[]): number | null {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = parsePrice(v)
      if (n != null) return n
    }
  }
  return null
}

function fromNextData(nd: NextData, sourceUrl: string): NewListing[] {
  const candidates: unknown[] =
    nd.props?.pageProps?.listings ??
    nd.props?.pageProps?.results ??
    nd.props?.pageProps?.initialState?.search?.results ??
    []
  const out: NewListing[] = []
  for (const raw of candidates) {
    if (!raw || typeof raw !== 'object') continue
    const o = raw as Record<string, unknown>
    const slug = pickStr(o, 'uri', 'detailUrl', 'permalink', 'url')
    if (!slug) continue
    const url = absoluteUrl(slug, ROOT)
    if (!url) continue
    const title = pickStr(o, 'address', 'streetAddress', 'name', 'title') ?? 'HotPads listing'
    const price = pickNum(o, 'price', 'minRent', 'rent')
    const beds = pickNum(o, 'beds', 'bedrooms')
    const neighborhood = pickStr(o, 'neighborhood', 'displayNeighborhood')
    const photoUrl = pickStr(o, 'photo', 'imageUrl', 'thumbnail', 'mainPhoto')
    const photos = photoUrl ? [photoUrl] : []
    out.push({
      source: 'hotpads',
      source_url: url,
      title,
      price_monthly: price ?? null,
      beds: beds != null ? beds.toString() : null,
      neighborhood,
      photos,
      is_active: true,
      raw: { source_path: sourceUrl, listing: o },
    })
  }
  return out
}

function fromHtmlCards($: ReturnType<typeof cheerio.load>, sourceUrl: string): NewListing[] {
  const out: NewListing[] = []
  // HotPads card markup has used multiple class shapes; tolerate any anchor that
  // looks like a listing-detail link.
  $('a[href*="/listings/"], a[href*="/pad/"], a[href*="/building/"]').each((_, el) => {
    const $el = $(el)
    const href = $el.attr('href')
    if (!href) return
    const url = absoluteUrl(href, ROOT)
    if (!url) return
    const title =
      $el.find('[class*="address"], [class*="Address"]').first().text().trim() ||
      $el.text().trim().slice(0, 200)
    if (!title) return

    const priceText =
      $el.find('[class*="price"], [class*="Price"]').first().text() ||
      ($el.text().match(/\$\s?\d[\d,]*/)?.[0] ?? '')
    const price = parsePrice(priceText)
    const beds = parseBeds(title) ?? parseBeds($el.text())

    const $img = $el.find('img').first()
    const photoSrc = $img.attr('src') ?? $img.attr('data-src')
    const photo = photoSrc ? absoluteUrl(photoSrc, ROOT) : null

    out.push({
      source: 'hotpads',
      source_url: url,
      title,
      price_monthly: price ?? null,
      beds,
      photos: photo ? [photo] : [],
      is_active: true,
      raw: { source_path: sourceUrl, html_card: true },
    })
  })
  const seen = new Set<string>()
  return out.filter((l) => {
    if (seen.has(l.source_url)) return false
    seen.add(l.source_url)
    return true
  })
}

async function probe(url: string): Promise<NewListing[]> {
  try {
    const res = await throttledFetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const html = await res.text()
    if (isBlocked(html)) throw new Error('blocked (challenge or empty body)')

    const $ = cheerio.load(html)

    // 1. __NEXT_DATA__
    const nextScript = $('#__NEXT_DATA__').contents().text() || $('#__NEXT_DATA__').html()
    if (nextScript && nextScript.trim()) {
      try {
        const parsed = JSON.parse(nextScript) as NextData
        const fromNext = fromNextData(parsed, url)
        if (fromNext.length) return fromNext
      } catch {
        // fall through
      }
    }

    // 2. HTML cards
    return fromHtmlCards($, url)
  } catch (err) {
    logScrapeError('hotpads', url, err)
    return []
  }
}

/**
 * Walk probes in order; first non-empty result wins. Returns [] if every probe
 * is blocked — Apify's `epctex~hotpads-scraper` covers the failover path.
 */
export async function fetchHotPads(): Promise<NewListing[]> {
  for (const probeUrl of PROBES) {
    const got = await probe(probeUrl)
    if (got.length > 0) return got
  }
  return []
}
