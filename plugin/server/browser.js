// Browser fallback: reads the Reddit website's JSON pages through the user's own Chrome, driven by
// playwright-cli over the Playwright extension. Used only when the user turned it on and the API
// credentials are missing. One page at a fixed pace, and it stops at anything that is not data:
// it never works around blocks, sign-in walls, CAPTCHAs or rate limits.

import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RedditError } from './errors.js'

const ORIGIN = 'https://www.reddit.com'
const SESSION = 'reddit-sentiment'
const PACE_MS = 3000
const IDLE_MS = 10 * 60_000
const CACHE_TTL_MS = 15 * 60_000
const READ_PAGE = "(document.querySelector('pre') || document.body).innerText"
const GAP_REASONS = new Set(['private', 'quarantined', 'banned', 'gold_only', 'employees_only', 'gated'])

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// playwright-cli writes snapshot files into its working folder, so it runs in the plugin's data folder,
// never in the user's project.
function runCli(cli, args) {
  const cwd = process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'reddit-sentiment-browser')
  mkdirSync(cwd, { recursive: true })
  return new Promise((resolve, reject) => {
    execFile(cli, args, { cwd, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }, (error, stdout, stderr) => {
      if (!error) return resolve(stdout)
      const message = (stdout || stderr || error.message).trim().split('\n')[0]
      reject(Object.assign(new Error(message), { code: error.code }))
    })
  })
}

function pageError(status, body, path) {
  const reason = typeof body?.reason === 'string' ? body.reason : null
  if ((status === 403 && GAP_REASONS.has(reason)) || (status === 404 && reason === 'banned')) {
    return new RedditError('forbidden', `${path}: community is ${reason}`, status)
  }
  if (status === 404) return new RedditError('not_found', `${path}: not found`, status)
  return new RedditError('browser', `Reddit answered ${path} with ${status} in the browser. The browser fallback stopped so it does not return partial data.`, status)
}

export function createBrowserClient({ cli = 'playwright-cli', run, paceMs = PACE_MS, sleep = defaultSleep, now = Date.now, log = () => {} } = {}) {
  const exec = run ?? ((args) => runCli(cli, args))
  const session = `-s=${SESSION}`
  const cache = new Map()
  let attached = false
  let calls = 0
  let lastAt = 0
  let queue = Promise.resolve()

  function serialize(task) {
    const result = queue.then(task, task)
    queue = result.catch(() => {})
    return result
  }

  const isAlive = () =>
    exec([session, '--raw', 'eval', '1']).then(
      () => true,
      () => false,
    )

  async function attach() {
    if (attached) return
    if (!(await isAlive())) {
      try {
        await exec(['attach', '--extension=chrome', `--session=${SESSION}`, `--idle-timeout=${IDLE_MS}`])
      } catch (error) {
        const cause = error.code === 'ENOENT' ? `${cli} is not installed or not on the PATH` : error.message
        throw new RedditError(
          'browser',
          `The browser fallback could not attach to Chrome: ${cause}. It needs playwright-cli, Chrome open, and the Playwright extension installed and allowed to connect.`,
        )
      }
      if (!(await isAlive())) {
        throw new RedditError(
          'browser',
          'Chrome did not keep the browser fallback connected. Approve the Playwright extension when Chrome asks, then run the scan again.',
        )
      }
      log('browser fallback: attached to Chrome')
    }
    attached = true
  }

  async function command(args, path) {
    try {
      return await exec([session, ...args])
    } catch (error) {
      attached = false
      throw new RedditError('browser', `The browser fallback lost Chrome while reading ${path}: ${error.message}. Run the scan again.`)
    }
  }

  async function read(url, path) {
    await command(['goto', url], path)
    const raw = await command(['--raw', 'eval', READ_PAGE], path)
    let text = raw
    try {
      text = JSON.parse(raw)
    } catch {}
    try {
      return JSON.parse(text)
    } catch {
      const snippet = String(text).replace(/\s+/g, ' ').trim().slice(0, 160)
      throw new RedditError(
        'browser',
        `Reddit showed a page instead of data for ${path}: "${snippet}". The browser fallback stops here and does not work around blocks, sign-in walls or CAPTCHAs.`,
      )
    }
  }

  async function paced(url, path) {
    const wait = lastAt + paceMs - now()
    if (wait > 0) await sleep(wait)
    lastAt = now()
    calls++
    return read(url, path)
  }

  async function get(path, params = {}) {
    const query = new URLSearchParams({ raw_json: '1' })
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value))
    }
    const url = `${ORIGIN}${path}.json?${query}`
    const hit = cache.get(url)
    if (hit && hit.expiresAt > now()) return hit.body

    return serialize(async () => {
      await attach()
      let body = await paced(url, path)
      if (body?.error === 429) {
        log('browser fallback: Reddit answered 429, waiting 60 s once')
        await sleep(60_000)
        body = await paced(url, path)
        if (body?.error === 429) {
          throw new RedditError('rate_limited', 'Reddit kept answering 429 Too Many Requests to the browser. Try again later.', 429)
        }
      }
      if (!Array.isArray(body) && typeof body?.error === 'number') throw pageError(body.error, body, path)
      cache.set(url, { body, expiresAt: now() + CACHE_TTL_MS })
      return body
    })
  }

  function stats() {
    return { data_source: 'browser_fallback', api_calls: calls, rate_limit: null }
  }

  const credentials = {
    sources: { data: 'browser fallback: the Reddit website through your Chrome, not the Data API' },
    userAgent: 'your Chrome',
  }

  return { get, stats, credentials }
}
