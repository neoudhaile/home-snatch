/**
 * Listings Project (https://www.listingsproject.com).
 *
 * Site is a React/Next-style SSR. We probe the listing page HTML and try, in
 * order:
 *   1. NextJS `__NEXT_DATA__` JSON blob (most reliable when present).
 *   2. JSON-LD `<script type="application/ld+json">` blocks (schema.org/Apartment).
 *   3. Plain HTML cards (cheerio fallback) — title + price + link + neighborhood.
 *
 * The site has no public listings JSON endpoint we can rely on, so we keep this
 * tolerant: any path that yields a usable result wins; failures are logged and
 * we return what we have.
 */

import * as cheerio from 'cheerio'
import type { NewListing } from '@/types'
import { canonicalize } from '@/lib/neighborhoods'

// @types/cheerio (legacy) and runtime cheerio v1 disagree on the return type
// of `cheerio.load`. Use the runtime return type so internal helpers stay typed.
type Cheerio$ = ReturnType<typeof cheerio.load>
import {
  absoluteUrl,
  logScrapeError,
  parseBeds,
  parsePrice,
  throttledFetch,
} from './_util'

const ROOT = 'https://www.listingsproject.com'
const PROBES = [
  `${ROOT}/listings/new-york`,
  `${ROOT}/listings`,
  `${ROOT}/search?location=new-york`,
  ROOT,
]

type NextData = {
  props?: {
    pageProps?: {
      listings?: unknown[]
      results?: unknown[]
      data?: { listings?: unknown[] }
    }
  }
}

/** Heuristic: cast an unknown record to a listing-like shape we can read. */
function asListingLike(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  return raw as Record<string, unknown>
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
    nd.props?.pageProps?.data?.listings ??
    []
  const out: NewListing[] = []
  for (const raw of candidates) {
    const o = asListingLike(raw)
    if (!o) continue
    const title = pickStr(o, 'title', 'headline', 'name')
    const slugOrUrl =
      pickStr(o, 'url', 'permalink', 'href') ??
      (pickStr(o, 'slug') ? `${ROOT}/listings/${pickStr(o, 'slug')}` : null)
    const url = slugOrUrl ? absoluteUrl(slugOrUrl, ROOT) : null
    if (!title || !url) continue
    const price = pickNum(o, 'price', 'rent', 'monthly_rent', 'price_monthly')
    const description = pickStr(o, 'description', 'body', 'summary')
    const neighborhood = pickStr(o, 'neighborhood', 'area')
    const borough = pickStr(o, 'borough', 'city')
    const photosRaw = (o['photos'] ?? o['images'] ?? o['photo_urls']) as unknown
    const photos: string[] = Array.isArray(photosRaw)
      ? photosRaw
          .map((p) =>
            typeof p === 'string'
              ? p
              : p && typeof p === 'object' && 'url' in (p as Record<string, unknown>)
                ? ((p as Record<string, unknown>).url as string)
                : null
          )
          .filter((s): s is string => typeof s === 'string')
          .map((s) => absoluteUrl(s, ROOT))
          .filter((s): s is string => !!s)
      : []
    const beds = parseBeds(`${title} ${description ?? ''}`)
    const postedRaw = pickStr(o, 'posted_at', 'created_at', 'updated_at', 'date')
    const posted_at = postedRaw ? new Date(postedRaw) : null

    out.push({
      source: 'listings-project',
      source_url: url,
      title,
      description,
      price_monthly: price ?? null,
      beds,
      photos,
      // Canonicalize so "SoHo" / "Soho" / "South of Houston" all become "SoHo"
      // in the DB.
      neighborhood: canonicalize(neighborhood) ?? neighborhood,
      borough,
      posted_at: posted_at && !Number.isNaN(posted_at.getTime()) ? posted_at : null,
      is_active: true,
      raw: { source_path: sourceUrl, listing: o },
    })
  }
  return out
}

/** Normalize a JSON-LD `image` field — string | string[] | { url } | { url }[]. */
function jsonLdImages(o: Record<string, unknown>): string[] {
  const raw = o['image'] ?? o['photos'] ?? o['images']
  if (!raw) return []
  const arr = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const v of arr) {
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      out.push(v)
    } else if (v && typeof v === 'object') {
      const url = (v as Record<string, unknown>).url
      if (typeof url === 'string' && /^https?:\/\//.test(url)) out.push(url)
    }
  }
  return out
}

function fromJsonLd($: Cheerio$, sourceUrl: string): NewListing[] {
  const out: NewListing[] = []
  $('script[type="application/ld+json"]').each((_, el) => {
    const txt = $(el).contents().text() || $(el).html() || ''
    if (!txt.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(txt)
    } catch {
      return
    }
    const items = Array.isArray(parsed) ? parsed : [parsed]
    for (const item of items) {
      const o = asListingLike(item)
      if (!o) continue
      const t = (o['@type'] as string | undefined) ?? ''
      if (!/Apartment|RentAction|Residence|RealEstateListing|Offer/i.test(t)) continue
      const title = pickStr(o, 'name', 'headline')
      const url = pickStr(o, 'url') ?? sourceUrl
      if (!title) continue
      const offers = (o['offers'] as Record<string, unknown> | undefined) ?? {}
      const price = pickNum(offers, 'price') ?? pickNum(o, 'price')
      out.push({
        source: 'listings-project',
        source_url: absoluteUrl(url, ROOT) ?? sourceUrl,
        title,
        description: pickStr(o, 'description'),
        price_monthly: price ?? null,
        beds: parseBeds(title),
        // schema.org/Apartment carries `image` as string|string[]|{url}|{url}[]
        photos: jsonLdImages(o),
        is_active: true,
        raw: { jsonld: o, source_path: sourceUrl },
      })
    }
  })
  return out
}

function fromHtmlCards($: Cheerio$, sourceUrl: string): NewListing[] {
  const out: NewListing[] = []
  $('a').each((_, el) => {
    const href = $(el).attr('href')
    if (!href || !/\/listings\/[A-Za-z0-9-]+/.test(href)) return
    const url = absoluteUrl(href, ROOT)
    if (!url) return
    const $a = $(el)
    const title = $a.text().trim().slice(0, 200)
    if (!title) return
    // Pull any <img> inside or adjacent to the card link. Listings Project's
    // grid cards typically wrap a thumb in <a>; grab any image src/srcset.
    const photoSet = new Set<string>()
    $a.find('img').each((_i, img) => {
      const $img = $(img)
      const src = $img.attr('src') || $img.attr('data-src')
      const abs = absoluteUrl(src, ROOT)
      if (abs) photoSet.add(abs)
      const srcset = $img.attr('srcset') || $img.attr('data-srcset')
      if (srcset) {
        // srcset is "url1 1x, url2 2x" — pull the URLs.
        for (const part of srcset.split(',')) {
          const u = part.trim().split(/\s+/)[0]
          const abs2 = absoluteUrl(u, ROOT)
          if (abs2) photoSet.add(abs2)
        }
      }
    })
    out.push({
      source: 'listings-project',
      source_url: url,
      title,
      photos: [...photoSet],
      is_active: true,
      raw: { source_path: sourceUrl, html_card: true },
    })
  })
  // Dedup by URL
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

    // 2. JSON-LD
    const ld = fromJsonLd($, url)
    if (ld.length) return ld

    // 3. HTML cards
    return fromHtmlCards($, url)
  } catch (err) {
    logScrapeError('listings-project', url, err)
    return []
  }
}

export async function fetchListingsProject(): Promise<NewListing[]> {
  // Walk probes in order; first non-empty wins. Each `throttledFetch` already
  // gates per-host, so this naturally sleeps ≥3s between probes.
  for (const probeUrl of PROBES) {
    const got = await probe(probeUrl)
    if (got.length > 0) return got
  }
  return []
}
