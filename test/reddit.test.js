import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRedditClient, listing } from '../plugin/server/reddit.js'
import { TEST_CREDENTIALS, loadFixture, startFakeReddit } from './fake-reddit.js'

const fixture = loadFixture(fileURLToPath(new URL('./fixtures/synthetic.json', import.meta.url)))
const credentials = { ...TEST_CREDENTIALS, userAgent: 'test:reddit-sentiment:0 (by /u/test_owner)' }

async function setup(options = {}, clientOptions = {}) {
  const fake = await startFakeReddit(fixture, options)
  const waits = []
  const client = createRedditClient({
    credentials: clientOptions.credentials ?? credentials,
    authUrl: fake.authUrl,
    apiBase: fake.apiBase,
    maxQpm: 100_000,
    sleep: async (ms) => waits.push(ms),
  })
  return { fake, client, waits }
}

test('authenticates once, sends the User-Agent and raw_json, caches reads', async (t) => {
  const { fake, client } = await setup()
  t.after(fake.close)
  const body = await client.get('/r/camping/about')
  assert.equal(body.data.display_name, 'camping')
  await client.get('/r/camping/about')
  const tokenCalls = fake.requests.filter((r) => r.path === '/api/v1/access_token')
  const apiCalls = fake.requests.filter((r) => r.path === '/r/camping/about')
  assert.equal(tokenCalls.length, 1)
  assert.equal(apiCalls.length, 1, 'second read comes from the cache')
  assert.equal(apiCalls[0].userAgent, credentials.userAgent)
  assert.equal(apiCalls[0].params.get('raw_json'), '1')
  assert.equal(client.stats().api_calls, 2)
  assert.equal(client.stats().rate_limit.remaining, 99)
})

test('rejected credentials stop with a clear, fatal error', async (t) => {
  const { fake, client } = await setup({}, { credentials: { ...credentials, clientSecret: 'wrong' } })
  t.after(fake.close)
  await assert.rejects(client.get('/r/camping/about'), (error) => {
    assert.equal(error.kind, 'credentials')
    assert.equal(error.fatal, true)
    assert.match(error.message, /rejected the app credentials \(HTTP 401\)/)
    return true
  })
})

test('a 429 is retried after the wait Reddit asks for', async (t) => {
  const { fake, client, waits } = await setup({ rateLimitOnce: '/r/camping/top' })
  t.after(fake.close)
  const body = await client.get('/r/camping/top', { t: 'month' })
  assert.equal(body.kind, 'Listing')
  assert.equal(fake.requests.filter((r) => r.path === '/r/camping/top').length, 2)
  assert.ok(waits.includes(0), 'waited retry-after 0 s')
})

test('an expired token is renewed once', async (t) => {
  const { fake, client } = await setup({ expireTokenOnce: true })
  t.after(fake.close)
  const body = await client.get('/r/camping/about')
  assert.equal(body.data.display_name, 'camping')
  assert.equal(fake.requests.filter((r) => r.path === '/api/v1/access_token').length, 2)
})

test('a private community is a gap, a reasonless 403 stops everything', async (t) => {
  const { fake, client } = await setup()
  t.after(fake.close)
  await assert.rejects(client.get('/r/privatecampers/about'), (error) => error.kind === 'forbidden' && !error.fatal)
  await assert.rejects(client.get('/r/doesnotexist/about'), (error) => error.kind === 'not_found' && !error.fatal)

  const denied = await setup({ forbidAll: true })
  t.after(denied.fake.close)
  await assert.rejects(denied.client.get('/r/camping/about'), (error) => {
    assert.equal(error.kind, 'access')
    assert.equal(error.fatal, true)
    assert.match(error.message, /not approved/)
    return true
  })
})

test('an exhausted rate limit waits for the reset', async (t) => {
  const { fake, client, waits } = await setup({ remaining: 0 })
  t.after(fake.close)
  await client.get('/r/camping/about')
  await client.get('/r/backpacking/about')
  assert.ok(waits.some((ms) => ms > 50_000 && ms <= 60_000), `waits ${waits}`)
})

test('a low remaining budget spreads requests over the reset window', async (t) => {
  const { fake, client, waits } = await setup({ remaining: 4 })
  t.after(fake.close)
  await client.get('/r/camping/about')
  await client.get('/r/backpacking/about')
  assert.ok(waits.some((ms) => ms > 10_000 && ms <= 15_000), `waits ${waits}`)
})

test('listing rejects an unexpected shape instead of reading it as empty', () => {
  assert.throws(() => listing({ kind: 't5', data: {} }, 't3', '/x'), (error) => error.kind === 'shape')
  assert.deepEqual(listing({ kind: 'Listing', data: { after: 'a', children: [{ kind: 't3', data: { id: 1 } }, { kind: 'more', data: {} }] } }, 't3', '/x'), {
    items: [{ id: 1 }],
    after: 'a',
  })
})
