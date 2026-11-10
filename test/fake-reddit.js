// A local stand-in for Reddit's OAuth and Data API that serves a fixture file.
// Tests import startFakeReddit(); `node test/fake-reddit.js [fixture] [port]` runs it on its own.
// Fixture keys are "GET <path>" plus "?q=" or "?after=" when the request has them.
// Timestamps shift so the fixture's _recorded_utc reads as now.

import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const TEST_CREDENTIALS = { clientId: 'test-id', clientSecret: 'test-secret', username: 'test_owner' }
const PRIVATE = new Set(['privatecampers'])

export function loadFixture(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

export function shiftTimes(value, shift) {
  if (Array.isArray(value)) return value.map((item) => shiftTimes(item, shift))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'created_utc' ? v + shift : shiftTimes(v, shift)]))
  }
  return value
}

export function fixtureKey(path, params) {
  const q = params.get('q')
  const after = params.get('after')
  if (q) return `GET ${path}?q=${q}`
  if (after) return `GET ${path}?after=${after}`
  return `GET ${path}`
}

// options: rateLimitOnce (path answered 429 once), expireTokenOnce, forbidAll, remaining (rate limit header),
// searchFallback (an unknown community search answers with the first search fixture)
export async function startFakeReddit(fixture, options = {}) {
  const requests = []
  const limited = new Set()
  let tokenCount = 0
  let expired = !options.expireTokenOnce
  const shift = Math.round(Date.now() / 1000 - fixture._recorded_utc)
  const expectedBasic = `Basic ${Buffer.from(`${TEST_CREDENTIALS.clientId}:${TEST_CREDENTIALS.clientSecret}`).toString('base64')}`

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost')
    requests.push({ method: req.method, path: url.pathname, params: url.searchParams, userAgent: req.headers['user-agent'] })
    const reply = (status, body, headers = {}) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        'x-ratelimit-remaining': String(options.remaining ?? 99),
        'x-ratelimit-used': '1',
        'x-ratelimit-reset': '60',
        ...headers,
      })
      res.end(JSON.stringify(body))
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/access_token') {
      if (req.headers.authorization !== expectedBasic) return reply(401, { message: 'Unauthorized', error: 401 })
      tokenCount++
      return reply(200, { access_token: `token-${tokenCount}`, token_type: 'bearer', expires_in: 86400, scope: '*' })
    }

    const auth = req.headers.authorization ?? ''
    if (!auth.startsWith('Bearer token-')) return reply(401, { message: 'Unauthorized', error: 401 })
    if (!expired && auth === 'Bearer token-1') {
      expired = true
      return reply(401, { message: 'Unauthorized', error: 401 })
    }
    if (options.forbidAll) return reply(403, { message: 'Forbidden', error: 403 })
    if (options.rateLimitOnce === url.pathname && !limited.has(url.pathname)) {
      limited.add(url.pathname)
      return reply(429, { message: 'Too Many Requests', error: 429 }, { 'retry-after': '0', 'x-ratelimit-remaining': '0' })
    }
    const community = url.pathname.match(/^\/r\/([^/]+)/)?.[1]
    if (community && PRIVATE.has(community)) return reply(403, { reason: 'private', message: 'Forbidden', error: 403 })

    let body = fixture.responses[fixtureKey(url.pathname, url.searchParams)]
    if (body === undefined && options.searchFallback && url.pathname === '/subreddits/search') {
      body = Object.entries(fixture.responses).find(([key]) => key.startsWith('GET /subreddits/search?q='))?.[1]
    }
    if (body === undefined) return reply(404, { message: 'Not Found', error: 404 })
    return reply(200, shiftTimes(body, shift))
  })

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    authUrl: `${base}/api/v1/access_token`,
    apiBase: base,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixturePath = process.argv[2] ?? fileURLToPath(new URL('./fixtures/synthetic.json', import.meta.url))
  const fake = await startFakeReddit(loadFixture(fixturePath), { port: Number(process.argv[3] ?? 8765), searchFallback: true })
  console.log(`Fake Reddit on ${fake.apiBase}`)
  console.log(`REDDIT_API_BASE=${fake.apiBase} REDDIT_AUTH_URL=${fake.authUrl}`)
  console.log(`REDDIT_CLIENT_ID=${TEST_CREDENTIALS.clientId} REDDIT_CLIENT_SECRET=${TEST_CREDENTIALS.clientSecret} REDDIT_USERNAME=${TEST_CREDENTIALS.username}`)
}
