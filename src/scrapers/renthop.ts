/**
 * RentHop direct scraper.
 *
 * Strategy: probe https://www.renthop.com/search/nyc with a Safari UA. RentHop
 * is the rare NYC-native rental site that historically hasn't sat behind a
 * full Akamai/Cloudflare gauntlet — direct fetch + cheerio works most of the
 * time. If the probe returns 403/Cloudflare we surrender quietly (Apify's
 * `epctex~renthop-scraper` is the failover, registered in `apify.ts`).
 *
 * Output: search-page hits with title / price / URL / photo / neighborhood.
 * Detail pages aren't fetched here (RentHop's detail pages are React-rendered
 * and require JS — Apify covers that path). The search-card data is enough to
 * surface a listing in the feed; the user can click through.
 *
 * Rate-limit: throttledFetch already gates ≥3s per host.
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

const ROOT = 'https://www.renthop.com'

/**
 * Areas we probe — borough-level paths, in priority order. RentHop's URL
 * structure is /search/<area>; if NYC umbrella works the per-borough probes
 * are skipped (they're expensive and overlap).
 */
const PROBES = [
  `${ROOT}/search/nyc`,
  `${ROOT}/search/manhattan`,
  `${ROOT}/search/brooklyn`,
  `${ROOT}/search/queens`,
] as const

/**
 * Detect the "we don't serve you here" / Cloudflare-challenge HTML. RentHop has
 * occasionally bounced direct-fetch traffic into a JS challenge page; the body
 * is small and contains "Just a moment". When we hit one we abort the probe.
 */
function isBlocked(html: string): boolean {
  if (html.length < 800) return true
  return /just a moment|cloudflare|access denied|cf-browser-verification/i.test(html)
}

function parseSearchHtml(html: string, sourceUrl: string): NewListing[] {
  const $ = cheerio.load(html)
  const out: NewListing[] = []

  // RentHop's search results live in repeating `<div class="...listing-card...">`
  // wrappers. Markup has shifted across years; we tolerate multiple selectors.
  const cards = $(
    'div.listing-card, div[class*="ListingCard"], a[href*="/listings/"], div[data-testid*="listing-card"]',
  )
  cards.each((_, el) => {
    const $el = $(el)
    const $link = $el.is('a') ? $el : $el.find('a[href*="/listings/"]').first()
    const href = $link.attr('href')
    if (!href) return
    const url = absoluteUrl(href, ROOT)
    if (!url || !/\/listings\//.test(url)) return

    const title =
      $el.find('[class*="address"], [class*="Address"], h2, h3').first().text().trim() ||
      $link.text().trim().slice(0, 200)
    if (!title) return

    const priceText =
      $el.find('[class*="price"], [class*="Price"]').first().text() ||
      ($el.text().match(/\$\s?\d[\d,]*/)?.[0] ?? '')
    const price = parsePrice(priceText)

    const beds =
      parseBeds($el.find('[class*="bed"], [class*="Bed"]').first().text() || '') ??
      parseBeds(title)

    const neighborhoodText =
      $el.find('[class*="neighborhood"], [class*="Neighborhood"]').first().text().trim() || null

    const $img = $el.find('img').first()
    const photoSrc = $img.attr('src') ?? $img.attr('data-src')
    const photo = photoSrc ? absoluteUrl(photoSrc, ROOT) : null

    out.push({
      source: 'renthop',
      source_url: url,
      title,
      price_monthly: price ?? null,
      beds,
      neighborhood: neighborhoodText,
      borough: null,
      photos: photo ? [photo] : [],
      is_active: true,
      raw: { source_path: sourceUrl, html_card: true },
    })
  })

  // Dedupe by URL — search markup sometimes wraps the same listing in 2 anchors.
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
    if (!res.ok) {
      // 403 → almost always Cloudflare; bail to caller (which will move to next probe).
      throw new Error(`HTTP ${res.status}`)
    }
    const html = await res.text()
    if (isBlocked(html)) {
      throw new Error('blocked (Cloudflare challenge or empty body)')
    }
    return parseSearchHtml(html, url)
  } catch (err) {
    logScrapeError('renthop', url, err)
    return []
  }
}

/**
 * Probe RentHop search pages; first non-empty result wins. Returns [] if every
 * probe fails — Apify's `epctex~renthop-scraper` will pick up the slack.
 */
export async function fetchRenthop(): Promise<NewListing[]> {
  for (const probeUrl of PROBES) {
    const got = await probe(probeUrl)
    if (got.length > 0) return got
  }
  return []
}
