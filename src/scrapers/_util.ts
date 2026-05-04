/**
 * Shared scraper utilities: browser User-Agent, throttled fetch per host,
 * cheap absolute-URL helper, and best-effort price/beds parsers.
 */

const SAFARI_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'

export const USER_AGENT = SAFARI_UA

export const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': USER_AGENT,
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
}

/** Per-host last-request timestamps so we can throttle ≥3s. */
const lastRequestAt = new Map<string, number>()
const HOST_THROTTLE_MS = 3_000

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function sleep(ms: number) {
  if (ms <= 0) return
  await new Promise((r) => setTimeout(r, ms))
}

/**
 * Throttled fetch — gates each host to ≥HOST_THROTTLE_MS between calls,
 * applies a browser UA + standard headers, and times out after `timeoutMs`.
 */
export async function throttledFetch(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {}
): Promise<Response> {
  const host = hostOf(url)
  const last = lastRequestAt.get(host) ?? 0
  const wait = HOST_THROTTLE_MS - (Date.now() - last)
  if (wait > 0) await sleep(wait)
  lastRequestAt.set(host, Date.now())

  const { timeoutMs = 30_000, headers, ...rest } = init
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const merged = { ...DEFAULT_HEADERS, ...(headers ?? {}) } as Record<string, string>
    return await fetch(url, { ...rest, headers: merged, signal: ctrl.signal })
  } finally {
    clearTimeout(timer)
  }
}

/** Resolve relative URLs against a base; if `src` is already absolute return as-is. */
export function absoluteUrl(src: string | undefined | null, base: string): string | null {
  if (!src) return null
  const t = src.trim()
  if (!t) return null
  try {
    return new URL(t, base).toString()
  } catch {
    return null
  }
}

/** Parse a price like "$3,200/mo", "3200", "$3,200" → integer dollars or null. */
export function parsePrice(s: string | undefined | null): number | null {
  if (!s) return null
  const m = s.replace(/[, ]/g, '').match(/\$?\s*(\d{3,6})/)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isFinite(n) || n <= 0 || n > 100_000) return null
  return n
}

/**
 * Parse a beds count from a title or attr string. Accepts "2br", "2 BR", "studio",
 * "1 bed", "3-bedroom". Returns a numeric string (drizzle numeric) or null.
 */
export function parseBeds(s: string | undefined | null): string | null {
  if (!s) return null
  const lower = s.toLowerCase()
  if (/\bstudio\b/.test(lower)) return '0'
  const m = lower.match(/(\d+(?:\.\d+)?)\s*(?:br|bed|bedrooms?|bd)\b/)
  if (m) {
    const n = parseFloat(m[1])
    if (Number.isFinite(n) && n >= 0 && n <= 10) return n.toString()
  }
  return null
}

/** Parse "$100 fee", "$50 application fee" → integer dollars or null. */
export function parseFee(s: string): number | null {
  const m = s.match(/\$\s*(\d{2,4})\s*(?:application|app|admin)?\s*fee/i)
  if (m) {
    const n = parseInt(m[1], 10)
    if (Number.isFinite(n) && n >= 0 && n <= 5000) return n
  }
  return null
}

/**
 * Parse broker fee mentions. Returns either a percent (0-20) or raw text.
 *  - "no broker fee", "no fee" → { broker_fee_pct: 0, broker_fee_text: 'no fee' }
 *  - "broker fee 15%" → { broker_fee_pct: 15 }
 *  - "broker fee one month" → { broker_fee_text: 'one month' }
 */
export function parseBrokerFee(s: string): {
  broker_fee_pct?: number
  broker_fee_text?: string
} {
  const lower = s.toLowerCase()
  if (/\bno\s*(?:broker\s*)?fee\b/.test(lower)) {
    return { broker_fee_pct: 0, broker_fee_text: 'no fee' }
  }
  const pct = lower.match(/broker\s*fee[^%]{0,20}(\d{1,2})\s*%/)
  if (pct) {
    const n = parseInt(pct[1], 10)
    if (n >= 0 && n <= 20) return { broker_fee_pct: n }
  }
  const month = lower.match(/broker\s*fee[^.]{0,40}?(one|1|two|2)\s*months?/)
  if (month) return { broker_fee_text: `${month[1]} month(s)` }
  if (/broker\s*fee/.test(lower)) return { broker_fee_text: 'broker fee mentioned' }
  return {}
}

/** Find http(s)://... URLs to image hosts (i.redd.it, imgur, etc.) inside text. */
export function extractImageUrls(text: string): string[] {
  const re = /\bhttps?:\/\/[^\s)\]>]+\.(?:png|jpe?g|webp|gif)\b/gi
  const set = new Set<string>()
  for (const m of text.matchAll(re)) set.add(m[0])
  return [...set]
}

/** Extract a phone number (US) from arbitrary text, if any. */
export function extractPhone(text: string): string | undefined {
  const m = text.match(/(?:\+?1[\s.-]?)?\(?(\d{3})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined
}

/** Extract first email address from text, if any. */
export function extractEmail(text: string): string | undefined {
  const m = text.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)
  return m ? m[0] : undefined
}

/** Borough mapper for Craigslist subdomains and common abbreviations. */
export function clBorough(subdomain: string): string {
  switch (subdomain) {
    case 'newyork':
      return 'Manhattan'
    case 'brooklyn':
      return 'Brooklyn'
    case 'queens':
      return 'Queens'
    case 'bronx':
      return 'Bronx'
    case 'statenisland':
      return 'Staten Island'
    default:
      return ''
  }
}

/** Best-effort logger that includes source + URL on every error. */
export function logScrapeError(source: string, url: string, err: unknown) {
  const msg = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.warn(`[scrape:${source}] ${url} — ${msg}`)
}
