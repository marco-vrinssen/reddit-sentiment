import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBrowserClient } from '../plugin/server/browser.js'
import { TEST_CREDENTIALS, loadFixture, startFakeReddit } from './fake-reddit.js'
import { createFakeRun } from './fake-playwright.js'
import { startServer } from './harness.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/synthetic.json', import.meta.url))
const FAKE_CLI = fileURLToPath(new URL('./fake-playwright-cli.js', import.meta.url))
const fixture = loadFixture(FIXTURE)

function setup(options = {}) {
  const fake = createFakeRun(fixture, options)
  const waits = []
  const client = createBrowserClient({ run: fake.run, sleep: async (ms) => waits.push(ms), paceMs: 3000 })
  return { client, state: fake.state, waits }
}

test('reads Reddit JSON pages through the attached browser, paced and cached', async () => {
  const { client, state, waits } = setup()
  const top = await client.get('/r/camping/top', { t: 'month', limit: 100 })
  assert.equal(top.kind, 'Listing')
  assert.equal(state.url, 'https://www.reddit.com/r/camping/top.json?raw_json=1&t=month&limit=100')
  await client.get('/r/camping/top', { t: 'month', limit: 100 })
  await client.get('/r/camping/about')
  assert.equal(state.commands.filter((c) => c.startsWith('attach')).length, 1)
  assert.match(state.commands.find((c) => c.startsWith('attach')), /--extension=chrome --session=reddit-sentiment --idle-timeout=600000/)
  assert.equal(state.commands.filter((c) => c.includes('goto')).length, 2, 'second top read came from the cache')
  assert.ok(waits.some((ms) => ms > 2000 && ms <= 3000), `paced: ${waits}`)
  assert.deepEqual(client.stats(), { data_source: 'browser_fallback', api_calls: 2, rate_limit: null })
})

test('reuses a session that is still attached', async () => {
  const { client, state } = setup({ attached: true })
  await client.get('/r/camping/about')
  assert.equal(state.commands.some((c) => c.startsWith('attach')), false)
})

test('a failed attach stops with setup steps', async () => {
  const { client } = setup({ noExtension: true })
  await assert.rejects(client.get('/r/camping/about'), (error) => {
    assert.equal(error.kind, 'browser')
    assert.equal(error.fatal, true)
    assert.match(error.message, /Playwright extension/)
    return true
  })
  const missing = createBrowserClient({ cli: 'playwright-cli', run: async () => { throw Object.assign(new Error('spawn'), { code: 'ENOENT' }) } })
  await assert.rejects(missing.get('/r/camping/about'), /playwright-cli is not installed/)
})

test('a block page stops instead of being worked around', async () => {
  const { client } = setup({ block: true })
  await assert.rejects(client.get('/r/camping/about'), (error) => {
    assert.equal(error.kind, 'browser')
    assert.match(error.message, /blocked by network security/)
    assert.match(error.message, /does not work around/)
    return true
  })
})

test('private and missing communities are gaps, 429 waits once then stops', async () => {
  const { client } = setup()
  await assert.rejects(client.get('/r/privatecampers/about'), (error) => error.kind === 'forbidden' && !error.fatal)
  await assert.rejects(client.get('/r/doesnotexist/about'), (error) => error.kind === 'not_found' && !error.fatal)

  const limited = setup({ rateLimited: true })
  await assert.rejects(limited.client.get('/r/camping/about'), (error) => error.kind === 'rate_limited')
  assert.ok(limited.waits.includes(60_000))
})

function serverEnv(dir, extra = {}) {
  return {
    REDDIT_SENTIMENT_BROWSER_FALLBACK: 'true',
    REDDIT_SENTIMENT_BROWSER_PACE_MS: '1000',
    PLAYWRIGHT_CLI: FAKE_CLI,
    FAKE_PLAYWRIGHT_FIXTURE: FIXTURE,
    FAKE_PLAYWRIGHT_STATE: join(dir, 'state.json'),
    ...extra,
  }
}

test('without credentials and with the fallback on, every result is labeled unofficial', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reddit-sentiment-browser-'))
  const server = startServer(serverEnv(dir))
  t.after(() => {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  })
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })

  const connection = await server.call('check_connection')
  assert.equal(connection.isError, false, connection.text)
  assert.equal(connection.json.data_source, 'browser_fallback')
  assert.match(connection.json.credentials_from.data, /not the Data API/)

  const collected = await server.call('collect_posts', { communities: [{ name: 'camping' }, { name: 'backpacking' }], days: 30 })
  assert.equal(collected.isError, false, collected.text)
  assert.equal(collected.json.data_source, 'browser_fallback')
  assert.equal(collected.json.posts.length, 14)

  const labels = collected.json.posts.map((p) => ({ id: p.id, stance: 1 }))
  const evidencePath = join(dir, 'reports', 'x-unofficial.evidence.json')
  const scored = await server.call('score_sentiment', { scan_id: collected.json.scan_id, mode: 'industry', labels, evidence_path: evidencePath })
  assert.equal(scored.json.data_source, 'browser_fallback')
  assert.match(scored.json.warnings[0], /^Unofficial data/)
  assert.equal(JSON.parse(readFileSync(evidencePath, 'utf8')).data_source, 'browser_fallback')

  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  assert.ok(state.commands.every((c) => !/stealth|captcha|proxy|user-agent/i.test(c)))
})

test('the fallback stays off unless turned on, and rejected credentials never fall back', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'reddit-sentiment-browser-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const off = startServer(serverEnv(dir, { REDDIT_SENTIMENT_BROWSER_FALLBACK: '' }))
  t.after(off.stop)
  const missing = await off.call('check_connection')
  assert.equal(missing.isError, true)
  assert.match(missing.text, /credentials missing/)
  assert.match(missing.text, /turn on the browser fallback/)

  const fake = await startFakeReddit(fixture)
  t.after(fake.close)
  const rejectedServer = startServer(
    serverEnv(dir, {
      REDDIT_API_BASE: fake.apiBase,
      REDDIT_AUTH_URL: fake.authUrl,
      REDDIT_CLIENT_ID: TEST_CREDENTIALS.clientId,
      REDDIT_CLIENT_SECRET: 'wrong',
      REDDIT_USERNAME: TEST_CREDENTIALS.username,
    }),
  )
  t.after(rejectedServer.stop)
  const rejected = await rejectedServer.call('check_connection')
  assert.equal(rejected.isError, true)
  assert.match(rejected.text, /rejected the app credentials/)
})
