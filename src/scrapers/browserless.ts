/**
 * Browserless.io headless-Chrome failover. Used as the second tier for any URL
 * we can't get with a direct fetch (CDN-blocked) and for which we don't have a
 * dedicated Apify actor. Returns rendered HTML or null if not configured.
 */

import { logScrapeError } from './_util'

const BROWSERLESS_BASE = 'https://chrome.browserless.io'

export function browserlessConfigured(): boolean {
  return !!process.env.BROWSERLESS_TOKEN
}

/**
 * Fetch the rendered HTML for a URL via Browserless. Returns null if the token
 * is missing or the fetch fails. Caller is expected to fall back to the next
 * tier (Apify or "give up").
 */
export async function fetchViaBrowserless(
  url: string,
  opts: { waitFor?: string; timeoutMs?: number } = {}
): Promise<string | null> {
  const token = process.env.BROWSERLESS_TOKEN
  if (!token) {
    // eslint-disable-next-line no-console
    console.warn(`[browserless] BROWSERLESS_TOKEN missing — skipping ${url}`)
    return null
  }
  const endpoint = `${BROWSERLESS_BASE}/content?token=${token}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60_000)
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        waitFor: opts.waitFor ?? 'body',
        gotoOptions: { waitUntil: 'networkidle2', timeout: opts.timeoutMs ?? 60_000 },
      }),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      throw new Error(`Browserless HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    }
    return await res.text()
  } catch (err) {
    logScrapeError('browserless', url, err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
