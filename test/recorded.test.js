// Replays real responses recorded with `npm run record`, so a change in Reddit's response shapes shows up
// offline. Skips until test/fixtures/recorded.json exists.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TEST_CREDENTIALS, loadFixture, startFakeReddit } from './fake-reddit.js'
import { startServer } from './harness.js'

const PATH = fileURLToPath(new URL('./fixtures/recorded.json', import.meta.url))
const recorded = existsSync(PATH)

test('recorded responses pass through every tool', { skip: !recorded && 'run npm run record with credentials first' }, async (t) => {
  const fake = await startFakeReddit(loadFixture(PATH))
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

  const found = await server.call('find_communities', { queries: ['camping'], limit_per_query: 10 })
  assert.equal(found.isError, false, found.text)
  assert.ok(found.json.candidates.length > 0)

  const measured = await server.call('measure_communities', { communities: ['camping'], max_pages: 1 })
  assert.equal(measured.isError, false, measured.text)
  assert.ok(measured.json.measured[0].subscribers > 0)

  const collected = await server.call('collect_posts', { communities: [{ name: 'camping' }, { name: 'BuyItForLife', query: 'tent' }], days: 30, fetch_limit: 25 })
  assert.equal(collected.isError, false, collected.text)
  assert.equal(collected.json.complete, true, JSON.stringify(collected.json.warnings))
  assert.ok(collected.json.posts.length > 0)

  const withComments = Object.keys(loadFixture(PATH).responses).find((key) => key.startsWith('GET /comments/'))
  if (withComments) {
    const comments = await server.call('get_comments', { post_ids: [withComments.split('/').at(-1)] })
    assert.equal(comments.isError, false, comments.text)
    assert.equal(comments.json.complete, true)
  }
})
