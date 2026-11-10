// End to end: the MCP server as a child process over stdio, against the fake Reddit.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_CREDENTIALS, loadFixture, startFakeReddit } from './fake-reddit.js'
import { startServer } from './harness.js'

const fixture = loadFixture(fileURLToPath(new URL('./fixtures/synthetic.json', import.meta.url)))

async function setup(t, options) {
  const fake = await startFakeReddit(fixture, options)
  const server = startServer({
    REDDIT_API_BASE: fake.apiBase,
    REDDIT_AUTH_URL: fake.authUrl,
    REDDIT_CLIENT_ID: TEST_CREDENTIALS.clientId,
    REDDIT_CLIENT_SECRET: TEST_CREDENTIALS.clientSecret,
    REDDIT_USERNAME: TEST_CREDENTIALS.username,
  })
  t.after(() => {
    server.stop()
    return fake.close()
  })
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  return { fake, server }
}

test('handshake and tool list', async (t) => {
  const { server } = await setup(t)
  const init = await server.request('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.result.protocolVersion, '2025-11-25')
  assert.equal(init.result.serverInfo.name, 'reddit-sentiment')
  const { result } = await server.request('tools/list', {})
  assert.deepEqual(
    result.tools.map((tool) => tool.name),
    ['check_connection', 'find_communities', 'measure_communities', 'collect_posts', 'get_comments', 'score_sentiment'],
  )
  for (const tool of result.tools) assert.equal(tool.annotations.readOnlyHint, true)
  assert.equal((await server.request('ping', {})).result !== undefined, true)
  assert.equal((await server.request('nope', {})).error.code, -32601)
  assert.equal((await server.request('tools/call', { name: 'nope', arguments: {} })).error.code, -32602)
})

test('missing credentials fail every tool with setup steps', async (t) => {
  const server = startServer({})
  t.after(server.stop)
  const result = await server.call('collect_posts', { communities: [{ name: 'camping' }] })
  assert.equal(result.isError, true)
  assert.match(result.text, /credentials missing\. Nothing was scanned/)
  assert.match(result.text, /security add-generic-password/)
})

test('invalid input is rejected before any request', async (t) => {
  const { server, fake } = await setup(t)
  const result = await server.call('collect_posts', { communities: [{ name: 'camping', extra: 1 }], days: 0 })
  assert.equal(result.isError, true)
  assert.match(result.text, /days must be at least 1/)
  assert.match(result.text, /extra is not a known field/)
  const bad = await server.call('collect_posts', { communities: [{ name: 'bad name!' }] })
  assert.match(bad.text, /not a valid community name/)
  assert.equal(fake.requests.length, 0)
})

test('full industry flow: find, measure, collect, comments, score', async (t) => {
  const { server } = await setup(t)

  const connection = await server.call('check_connection')
  assert.deepEqual(connection.json.credentials_from, { clientId: 'environment', clientSecret: 'environment', username: 'environment' })

  const found = await server.call('find_communities', { queries: ['tents', 'camping gear', 'unknown query'] })
  assert.equal(found.json.complete, false)
  assert.equal(found.json.failures.length, 1)
  assert.deepEqual(found.json.excluded, { nsfw: 1, unreadable: 1 })
  assert.equal(found.json.candidates[0].name, 'backpacking')
  assert.deepEqual(found.json.candidates.find((c) => c.name === 'camping').matched_queries, ['tents', 'camping gear'])

  const measured = await server.call('measure_communities', { communities: ['camping', 'r/backpacking', 'Ultralight', 'CampingGear', 'smalltents', 'privatecampers'] })
  assert.equal(measured.json.complete, false)
  assert.equal(measured.json.failures[0].kind, 'forbidden')
  const camping = measured.json.measured.find((m) => m.name === 'camping')
  assert.equal(camping.capped, true)
  assert.equal(camping.sample_posts, 200)
  assert.ok(Math.abs(camping.sample_days - 3) < 0.1, `sample_days ${camping.sample_days}`)
  const backpacking = measured.json.measured.find((m) => m.name === 'backpacking')
  assert.equal(backpacking.capped, false)
  assert.equal(backpacking.sample_posts, 60)
  assert.equal(backpacking.posts_per_day, 8.6)
  assert.equal(measured.json.measured.at(-1).name, 'smalltents')

  const tooMany = await server.call('collect_posts', { communities: ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => ({ name: `${n}${n}` })) })
  assert.match(tooMany.text, /at most 5 items/)

  const first = await server.call('collect_posts', { communities: [{ name: 'camping' }, { name: 'backpacking' }, { name: 'Ultralight' }], days: 30 })
  assert.equal(first.json.complete, true)
  const scan = first.json
  const second = await server.call('collect_posts', {
    scan_id: scan.scan_id,
    communities: [{ name: 'CampingGear' }, { name: 'BuyItForLife', query: 'tent' }, { name: 'privatecampers' }],
  })
  assert.equal(second.json.scan_id, scan.scan_id)
  assert.equal(second.json.complete, false)
  assert.match(second.json.warnings.join(' '), /privatecampers was not scanned/)
  assert.equal(second.json.window.from, scan.window.from)
  assert.deepEqual(second.json.scan_totals, {
    communities: 6,
    failed: 1,
    posts: 22,
    filtered: { outside_window: 1, removed: 1, bot: 2, moderator: 0, promotional: 2, meme: 1, low_engagement: 1, duplicate: 1 },
  })
  const repeat = await server.call('collect_posts', { scan_id: scan.scan_id, communities: [{ name: 'camping' }] })
  assert.match(repeat.text, /Already in scan-/)
  const ids = [...scan.posts, ...second.json.posts].map((p) => p.id)
  assert.equal(ids.length, 22)
  assert.equal(scan.posts.find((p) => p.id === 'c1').date.length, 10)
  for (const dropped of ['c7', 'c8', 'c9', 'c10', 'c11', 'c12', 'b5', 'b8', 'u5']) assert.ok(!ids.includes(dropped), dropped)
  assert.equal(second.json.coverage.find((c) => c.community === 'BuyItForLife').query, 'tent')
  assert.equal(scan.posts.find((p) => p.id === 'c1').url, 'https://www.reddit.com/r/camping/comments/c1/')

  const comments = await server.call('get_comments', { post_ids: ['c1', 't3_c2', 'zzz'], per_post: 5 })
  assert.equal(comments.json.complete, false)
  const c1 = comments.json.threads.find((thread) => thread.id === 'c1')
  assert.deepEqual(c1.comments.map((c) => c.score), [640, 320])
  assert.equal(c1.dropped, 3)
  assert.ok(!JSON.stringify(comments.json).includes('commenter_'), 'no usernames')

  const stance = { c1: 1, c2: -1, c3: 0, c4: 1, c5: -1, c6: 1, c13: -1, c14: 1, b1: 1, b2: 1, b3: -1, b4: 0, b6: 0, b7: 1, u1: 0, u2: 1, u3: -1, u4: 1, g1: 0, g2: -1, g3: 0, f1: 1 }
  const labels = ids.map((id) => ({ id, stance: stance[id], intent: stance[id] === 0 ? 'buying' : 'owning', themes: ['durability'], brands: id === 'c1' ? ['Big Agnes'] : [] }))
  labels[0].stance = null

  const unknown = await server.call('score_sentiment', { scan_id: scan.scan_id, mode: 'industry', labels: [{ id: 'nope', stance: 1 }] })
  assert.equal(unknown.isError, true)
  assert.match(unknown.text, /not in scan-/)

  const dir = mkdtempSync(join(tmpdir(), 'reddit-sentiment-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const evidencePath = join(dir, 'reports', '2026-11-10-tents.evidence.json')
  const scored = await server.call('score_sentiment', { scan_id: scan.scan_id, mode: 'industry', labels, evidence_path: evidencePath })
  const result = scored.json
  assert.deepEqual(result.sample, { returned: 22, labeled: 22, scored: 21, off_topic: 1, unlabeled: 0 })
  assert.ok(result.index > -100 && result.index < 100)
  assert.ok(['Invest', 'Watch', 'Avoid'].includes(result.verdict.call))
  assert.ok(result.verdict.would_change.length > 0)
  assert.equal(result.coverage, 0.833)
  assert.match(result.warnings.join(' '), /privatecampers/)
  assert.equal(result.themes[0].name, 'durability')
  assert.deepEqual(result.intents.map((i) => i.name).sort(), ['buying', 'owning'])

  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'))
  assert.equal(evidence.threads.length, 22)
  assert.equal(evidence.result.index, result.index)
  const total = evidence.threads.reduce((sum, thread) => sum + thread.index_weight, 0)
  assert.ok(Math.abs(total - 1) < 0.001, `index weights sum to ${total}`)
})

test('a reasonless 403 stops the scan instead of returning partial data', async (t) => {
  const { server } = await setup(t, { forbidAll: true })
  const result = await server.call('collect_posts', { communities: [{ name: 'camping' }, { name: 'backpacking' }] })
  assert.equal(result.isError, true)
  assert.match(result.text, /scan stopped so it does not return partial data/)
})
