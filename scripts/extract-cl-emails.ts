/**
 * Extract Craigslist relay emails from listings referenced in nyc_apartments.md.
 *
 * Why: Craigslist replaced server-rendered relay emails with a JS handshake to
 * `sapi.craigslist.org`. A direct fetch of the reply page returns 404. We need
 * a real browser to (1) render the listing, (2) click the reply button, (3)
 * wait for the relay email to populate, (4) scrape it.
 *
 * Uses Browserless's `/function` endpoint (full Puppeteer in one round-trip).
 *
 * Output: scripts/cl-inquiries.json — array of {url, postId, title, price,
 * neighborhood, email, replyUrl}.
 *
 * Run: BROWSERLESS_TOKEN=... npx tsx --env-file=.env.local scripts/extract-cl-emails.ts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MD_PATH = resolve(process.cwd(), 'nyc_apartments.md')
const OUT_PATH = resolve(process.cwd(), 'scripts/cl-inquiries.json')
const BROWSERLESS_BASE = 'https://chrome.browserless.io'

type Inquiry = {
  url: string
  postId: string
  title: string | null
  price: string | null
  neighborhood: string | null
  email: string | null
  error?: string
}

function parseListings(md: string): Array<{ url: string; title: string; price: string | null; neighborhood: string | null }> {
  const lines = md.split('\n')
  const out: Array<{ url: string; title: string; price: string | null; neighborhood: string | null }> = []
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
      out.push({
        url: urlMatch[1],
        title: pendingTitle,
        price: pendingPrice,
        neighborhood: currentNeighborhood,
      })
      pendingTitle = null
      pendingPrice = null
    }
  }
  // Dedupe by url
  const seen = new Set<string>()
  return out.filter((l) => (seen.has(l.url) ? false : (seen.add(l.url), true)))
}

function postIdFrom(url: string): string {
  const m = url.match(/\/(\d+)\.html$/)
  if (!m) throw new Error(`No post ID in ${url}`)
  return m[1]
}

async function extractEmail(url: string): Promise<{ email: string | null; error?: string }> {
  const token = process.env.BROWSERLESS_TOKEN
  if (!token) throw new Error('BROWSERLESS_TOKEN not set')

  // Puppeteer code runs server-side at Browserless.
  const fn = `
    export default async function ({ page, context }) {
      const { url, debug } = context;
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15');
      await page.setViewport({ width: 1280, height: 900 });
      await page.goto(url, { waitUntil: 'load', timeout: 45000 });

      // Trigger CL's reply-button JS by clicking it (the data-href is a placeholder
      // until the click handler fetches a service id).
      const btn = await page.$('button.reply-button');
      if (!btn) return { data: { email: null, error: 'no reply button' }, type: 'application/json' };

      // Wait for any handler attachment. Then click and wait for navigation.
      await new Promise((r) => setTimeout(r, 2000));
      const navPromise = page.waitForNavigation({ waitUntil: 'load', timeout: 25000 }).catch((e) => ({ error: e.message }));
      await btn.click();
      const navResult = await navPromise;

      if (debug) {
        const buttonHtml = await page.evaluate(() => {
          const b = document.querySelector('button.reply-button');
          return b ? b.outerHTML : '(no button after click)';
        });
        const html = await page.content();
        return { data: { email: null, error: 'debug-stop', debug: { finalUrl: page.url(), title: await page.title(), buttonHtml, navResult, htmlSnippet: html.slice(0, 3000) } }, type: 'application/json' };
      }

      const replyHref = page.url() !== url ? page.url() : null;
      if (!replyHref) {
        return { data: { email: null, error: 'click did not navigate' }, type: 'application/json' };
      }

      // We're already on the reply page after the click navigated.
      await new Promise((r) => setTimeout(r, 1500));

      const email = await page.evaluate(() => {
        const a = document.querySelector('a[href^="mailto:"]');
        if (a) return a.getAttribute('href').replace(/^mailto:/, '').split('?')[0];
        const m = document.body.innerText.match(/[a-zA-Z0-9._%+-]+@reply\\.craigslist\\.org/);
        return m ? m[0] : null;
      });

      if (debug) {
        const html = await page.content();
        const title = await page.title();
        return { data: { email, error: email ? null : 'no email on reply page', debug: { title, finalUrl: page.url(), htmlSnippet: html.slice(0, 4000) } }, type: 'application/json' };
      }
      return { data: { email, error: email ? null : 'no email on reply page' }, type: 'application/json' };
    }
  `

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60_000)
  try {
    const res = await fetch(`${BROWSERLESS_BASE}/function?token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: fn.trim(), context: { url, debug: !!process.env.DEBUG_BROWSERLESS } }),
      signal: ctrl.signal,
    })
    const raw = await res.text()
    if (!res.ok) {
      return { email: null, error: `browserless HTTP ${res.status}: ${raw}` }
    }
    if (process.env.DEBUG_BROWSERLESS) console.log('  [raw]', raw.slice(0, 1500))
    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { email: null, error: `non-JSON response: ${raw.slice(0, 200)}` }
    }
    // Browserless wraps: { data: {...}, type: 'application/json' }
    const inner = parsed?.data ?? parsed
    return { email: inner?.email ?? null, error: inner?.error }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { email: null, error: `fetch failed: ${msg}` }
  } finally {
    clearTimeout(timer)
  }
}

async function main() {
  const md = readFileSync(MD_PATH, 'utf8')
  const listings = parseListings(md)
  console.log(`[cl-emails] parsed ${listings.length} unique Craigslist listings from md`)

  const results: Inquiry[] = []
  for (let i = 0; i < listings.length; i++) {
    const l = listings[i]
    const tag = `[${i + 1}/${listings.length}]`
    process.stdout.write(`${tag} ${l.title.slice(0, 60)} ... `)
    try {
      const { email, error } = await extractEmail(l.url)
      results.push({
        url: l.url,
        postId: postIdFrom(l.url),
        title: l.title,
        price: l.price,
        neighborhood: l.neighborhood,
        email,
        error,
      })
      console.log(email ? `✓ ${email}` : `✗ ${error ?? 'no email'}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        url: l.url,
        postId: postIdFrom(l.url),
        title: l.title,
        price: l.price,
        neighborhood: l.neighborhood,
        email: null,
        error: msg,
      })
      console.log(`✗ ${msg}`)
    }
    // Polite throttle so we don't hammer either CL or browserless.
    await new Promise((r) => setTimeout(r, 1500))
  }

  writeFileSync(OUT_PATH, JSON.stringify(results, null, 2))
  const ok = results.filter((r) => r.email).length
  console.log(`\n[cl-emails] wrote ${OUT_PATH} (${ok}/${results.length} with email)`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
