// The only module that talks to Reddit. Official OAuth (application-only, client_credentials),
// requests paced by Reddit's own rate limit headers, retries on 429 and 5xx, and a short cache.

import { RedditError } from './errors.js'

const AUTH_URL = 'https://www.reddit.com/api/v1/access_token'
const API_BASE = 'https://oauth.reddit.com'
const CACHE_TTL_MS = 15 * 60_000
const MAX_RETRIES = 3
const MAX_WAIT_MS = 120_000
const SPREAD_BELOW = 10
const SUBREDDIT_GAP_REASONS = new Set(['private', 'quarantined', 'banned', 'gold_only', 'employees_only', 'gated'])

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function createRedditClient({
  credentials,
  authUrl = AUTH_URL,
  apiBase = API_BASE,
  maxQpm = 100,
  fetchImpl = globalThis.fetch,
  sleep = defaultSleep,
  now = Date.now,
  log = () => {},
}) {
  const minIntervalMs = Math.ceil(60_000 / maxQpm)
  const cache = new Map()
  const rate = { remaining: null, used: null, resetAt: null }
  let token = null
  let tokenExpiresAt = 0
  let lastRequestAt = 0
  let calls = 0
  let queue = Promise.resolve()

  // One request at a time, so pacing holds even when tools run in parallel.
  function serialize(task) {
    const run = queue.then(task, task)
    queue = run.catch(() => {})
    return run
  }

  async function pace() {
    const t = now()
    let wait = lastRequestAt + minIntervalMs - t
    if (rate.remaining !== null && rate.resetAt > t) {
      if (rate.remaining < 1) wait = Math.max(wait, rate.resetAt - t)
      else if (rate.remaining < SPREAD_BELOW) wait = Math.max(wait, (rate.resetAt - t) / rate.remaining)
    }
    if (wait > MAX_WAIT_MS) {
      throw new RedditError(
        'rate_limited',
        `Reddit's rate limit is used up and resets in ${Math.ceil(wait / 1000)} s. Run the scan again after that.`,
        429,
      )
    }
    if (wait > 0) {
      if (wait > 2000) log(`rate limit: waiting ${Math.ceil(wait / 1000)} s`)
      await sleep(wait)
    }
    lastRequestAt = now()
  }

  function readRateHeaders(res) {
    const remaining = parseFloat(res.headers.get('x-ratelimit-remaining'))
    const used = parseFloat(res.headers.get('x-ratelimit-used'))
    const reset = parseFloat(res.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(remaining)) rate.remaining = remaining
    if (Number.isFinite(used)) rate.used = used
    if (Number.isFinite(reset)) rate.resetAt = now() + reset * 1000
  }

  function retryDelay(res, attempt) {
    const after = res.headers.get('retry-after')
    if (after) {
      const seconds = Number(after)
      if (Number.isFinite(seconds)) return seconds * 1000
      const date = Date.parse(after)
      if (!Number.isNaN(date)) return Math.max(0, date - now())
    }
    const reset = parseFloat(res.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset)) return reset * 1000
    return 1000 * 2 ** attempt
  }

  // Paced fetch with retries on network errors, 429 and 5xx. Returns the last response.
  async function send(url, init) {
    for (let attempt = 0; ; attempt++) {
      await pace()
      calls++
      let res
      try {
        res = await fetchImpl(url, init)
      } catch (error) {
        if (attempt >= MAX_RETRIES) throw new RedditError('upstream', `Network error reaching Reddit: ${error.message}`)
        await sleep(1000 * 2 ** attempt)
        continue
      }
      readRateHeaders(res)
      if (res.status !== 429 && res.status < 500) return res
      if (attempt >= MAX_RETRIES) {
        if (res.status === 429) {
          throw new RedditError('rate_limited', 'Reddit still answered 429 Too Many Requests after 3 retries. Wait a few minutes and run the scan again.', 429)
        }
        return res
      }
      const wait = res.status === 429 ? retryDelay(res, attempt) : 1000 * 2 ** attempt
      if (wait > MAX_WAIT_MS) {
        throw new RedditError('rate_limited', `Reddit asked to wait ${Math.ceil(wait / 1000)} s before the next request. Run the scan again after that.`, 429)
      }
      log(`HTTP ${res.status}: retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(wait / 1000)} s`)
      await res.body?.cancel()
      await sleep(wait)
    }
  }

  async function authenticate() {
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')
    const res = await send(authUrl, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'User-Agent': credentials.userAgent,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    }).catch((error) => {
      if (error.kind === 'upstream') throw new RedditError('auth', `${error.message}. Nothing was scanned.`)
      throw error
    })
    const body = await readJson(res)
    if ([400, 401, 403].includes(res.status)) {
      throw new RedditError(
        'credentials',
        `Reddit rejected the app credentials (HTTP ${res.status}). Nothing was scanned. Check the client id and secret, and that the app is approved for Data API access.`,
        res.status,
      )
    }
    if (!res.ok) {
      throw new RedditError('auth', `Reddit's token endpoint answered HTTP ${res.status}. Nothing was scanned. Try again later.`, res.status)
    }
    if (typeof body?.access_token !== 'string') {
      const reason = body?.error ? ` (${body.error})` : ''
      throw new RedditError('credentials', `Reddit issued no access token${reason}. Nothing was scanned. Check the client id and secret.`)
    }
    token = body.access_token
    tokenExpiresAt = now() + (Number(body.expires_in) || 3600) * 1000 - 60_000
  }

  async function get(path, params = {}) {
    const query = new URLSearchParams({ raw_json: '1' })
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value))
    }
    const url = `${apiBase}${path}?${query}`
    const hit = cache.get(url)
    if (hit && hit.expiresAt > now()) return hit.body

    return serialize(async () => {
      for (let renewed = false; ; renewed = true) {
        if (!token || now() >= tokenExpiresAt) await authenticate()
        const res = await send(url, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': credentials.userAgent } })
        if (res.status === 401 && !renewed) {
          token = null
          await res.body?.cancel()
          continue
        }
        const body = await readJson(res)
        if (res.ok) {
          if (body === undefined) throw new RedditError('shape', `Reddit answered ${path} with a body that is not JSON.`)
          cache.set(url, { body, expiresAt: now() + CACHE_TTL_MS })
          return body
        }
        throw httpError(res.status, body, path)
      }
    })
  }

  function stats() {
    const resetIn = rate.resetAt ? Math.max(0, Math.round((rate.resetAt - now()) / 1000)) : null
    return {
      api_calls: calls,
      rate_limit: { remaining: rate.remaining, used: rate.used, resets_in_seconds: resetIn },
    }
  }

  return { get, stats, credentials }
}

async function readJson(res) {
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function httpError(status, body, path) {
  const reason = typeof body?.reason === 'string' ? body.reason : null
  if (status === 401) {
    return new RedditError('credentials', 'Reddit rejected a fresh access token (HTTP 401). Check that the app is approved for Data API access.', status)
  }
  if (status === 403 && reason && SUBREDDIT_GAP_REASONS.has(reason)) {
    return new RedditError('forbidden', `${path}: community is ${reason}`, status)
  }
  if (status === 403) {
    return new RedditError(
      'access',
      `Reddit refused ${path} (HTTP 403) without naming a reason. This usually means the app is not approved for this endpoint or for Data API access. The scan stopped so it does not return partial data.`,
      status,
    )
  }
  if (status === 404 && reason === 'banned') return new RedditError('forbidden', `${path}: community is banned`, status)
  if (status === 404) return new RedditError('not_found', `${path}: not found`, status)
  return new RedditError('upstream', `${path}: Reddit answered HTTP ${status}`, status)
}

// Unpacks a Listing and checks its shape, so a changed response fails loudly instead of reading as empty.
export function listing(body, kind, path) {
  if (body?.kind !== 'Listing' || !Array.isArray(body?.data?.children)) {
    throw new RedditError('shape', `Reddit answered ${path} with an unexpected shape (expected a Listing).`)
  }
  const items = body.data.children.filter((child) => child?.kind === kind).map((child) => child.data)
  return { items, after: body.data.after ?? null }
}
