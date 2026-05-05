/**
 * Async Apify runner.
 *
 * Why this exists: the previous `runApifyActor` used Apify's
 * `run-sync-get-dataset-items` endpoint, which blocks the HTTP connection
 * until the actor finishes. With Vercel Pro's 300s function ceiling that
 * leaves ~zero headroom for slow actors (e.g. Zillow can run 2-4min).
 *
 * Async pattern (this file):
 *   1. POST /v2/acts/<actorId>/runs?token=...        → start the run, get runId
 *   2. POLL GET /v2/actor-runs/<runId>?token=...     → wait for terminal status
 *   3. GET  /v2/datasets/<datasetId>/items?token=... → pull results
 *
 * Each step is wrapped in a single shared 240s `AbortController` so we leave a
 * 60s buffer under the 300s function limit. If the abort fires we attempt a
 * best-effort cancel on the run (POST /v2/actor-runs/<runId>/abort) so we
 * don't leak compute.
 *
 * Returns [] when no token is configured or any step fails — callers already
 * tolerate empty results.
 */

import { logScrapeError } from '@/scrapers/_util'

const APIFY_BASE = 'https://api.apify.com/v2'

/** 240s default — leaves 60s under Vercel Pro's 300s function ceiling. */
const DEFAULT_TIMEOUT_MS = 240_000

/** Poll cadence for the run-status endpoint. */
const POLL_INTERVAL_MS = 3_000

type ApifyRunStatus =
  | 'READY'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMING-OUT'
  | 'TIMED-OUT'
  | 'ABORTING'
  | 'ABORTED'

const TERMINAL_OK: ApifyRunStatus[] = ['SUCCEEDED']
const TERMINAL_BAD: ApifyRunStatus[] = ['FAILED', 'TIMED-OUT', 'ABORTED']

type RunResponse = {
  data: {
    id: string
    status: ApifyRunStatus
    defaultDatasetId: string
    startedAt?: string
    finishedAt?: string | null
  }
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('aborted', 'AbortError'))
      return
    }
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

/**
 * Best-effort run cancel — never throws, just logs. Used when our outer
 * AbortController fires so we don't leak Apify compute.
 */
async function abortRun(runId: string, token: string): Promise<void> {
  try {
    await fetch(
      `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}/abort?token=${token}`,
      { method: 'POST' },
    )
  } catch {
    // ignore
  }
}

/**
 * Run an Apify actor asynchronously.
 *
 * @param actorId  e.g. "epctex~hotpads-scraper" or "parseforge~zillow-rentals-scraper"
 * @param input    The actor input JSON (shape varies per actor).
 * @param opts     timeoutMs (default 240s), maxItems (default 200) for the
 *                 dataset-items GET, memoryMb (passed to the run start).
 */
export async function runApifyActorAsync<T = unknown>(
  actorId: string,
  input: unknown,
  opts: { timeoutMs?: number; maxItems?: number; memoryMb?: number } = {},
): Promise<T[]> {
  const token = process.env.APIFY_TOKEN
  if (!token) {
    console.warn(`[apify-async] APIFY_TOKEN missing — skipping ${actorId}`)
    return []
  }

  const totalTimeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxItems = opts.maxItems ?? 200

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), totalTimeout)
  let runId: string | null = null

  try {
    // ---- Step 1: start the run -----------------------------------------
    const startQs = new URLSearchParams({ token })
    if (opts.memoryMb) startQs.set('memory', String(opts.memoryMb))
    const startUrl = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?${startQs.toString()}`
    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: ctrl.signal,
    })
    if (!startRes.ok) {
      throw new Error(
        `start ${actorId} HTTP ${startRes.status}: ${await startRes
          .text()
          .catch(() => '')}`,
      )
    }
    const started = (await startRes.json()) as RunResponse
    runId = started.data.id

    // ---- Step 2: poll for terminal status ------------------------------
    let status: ApifyRunStatus = started.data.status
    let datasetId = started.data.defaultDatasetId
    while (!TERMINAL_OK.includes(status) && !TERMINAL_BAD.includes(status)) {
      await sleep(POLL_INTERVAL_MS, ctrl.signal)
      const pollUrl = `${APIFY_BASE}/actor-runs/${encodeURIComponent(runId)}?token=${token}`
      const pollRes = await fetch(pollUrl, { signal: ctrl.signal })
      if (!pollRes.ok) {
        throw new Error(
          `poll ${actorId} HTTP ${pollRes.status}: ${await pollRes
            .text()
            .catch(() => '')}`,
        )
      }
      const pj = (await pollRes.json()) as RunResponse
      status = pj.data.status
      datasetId = pj.data.defaultDatasetId
    }

    if (TERMINAL_BAD.includes(status)) {
      throw new Error(`${actorId} terminated with status=${status}`)
    }

    // ---- Step 3: pull dataset items ------------------------------------
    const itemsUrl = `${APIFY_BASE}/datasets/${encodeURIComponent(datasetId)}/items?token=${token}&limit=${maxItems}&clean=1`
    const itemsRes = await fetch(itemsUrl, { signal: ctrl.signal })
    if (!itemsRes.ok) {
      throw new Error(
        `items ${actorId} HTTP ${itemsRes.status}: ${await itemsRes
          .text()
          .catch(() => '')}`,
      )
    }
    const data = (await itemsRes.json()) as T[]
    return Array.isArray(data) ? data : []
  } catch (err) {
    // If we timed out or hit any error after the run started, best-effort
    // cancel the Apify run so we don't leak compute on slow actors.
    if (runId) {
      await abortRun(runId, token)
    }
    logScrapeError(`apify-async:${actorId}`, '(run)', err)
    return []
  } finally {
    clearTimeout(timer)
  }
}
