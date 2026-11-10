// Calls the real Reddit Data API with your credentials. Runs only with REDDIT_LIVE=1 (npm run test:live),
// since every call counts against the paid quota. About 6 calls.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadCredentials } from '../plugin/server/credentials.js'
import { startServer } from './harness.js'

const live = process.env.REDDIT_LIVE === '1'

test('live: connection, communities, posts and comments', { skip: !live && 'set REDDIT_LIVE=1 to call the real API' }, async (t) => {
  const credentials = loadCredentials()
  const server = startServer({
    REDDIT_SENTIMENT_NO_KEYCHAIN: '1',
    REDDIT_MAX_QPM: '60',
    REDDIT_CLIENT_ID: credentials.clientId,
    REDDIT_CLIENT_SECRET: credentials.clientSecret,
    REDDIT_USERNAME: credentials.username,
  })
  t.after(server.stop)
  await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } })

  const connection = await server.call('check_connection')
  assert.equal(connection.isError, false, connection.text)
  assert.equal(connection.json.ok, true)

  const found = await server.call('find_communities', { queries: ['camping'], limit_per_query: 5 })
  assert.equal(found.isError, false, found.text)
  assert.ok(found.json.candidates.length > 0)

  const measured = await server.call('measure_communities', { communities: ['camping'], max_pages: 1 })
  assert.equal(measured.isError, false, measured.text)
  assert.ok(measured.json.measured[0].subscribers > 0)

  const collected = await server.call('collect_posts', { communities: [{ name: 'camping' }], days: 7, fetch_limit: 25, per_community: 5 })
  assert.equal(collected.isError, false, collected.text)
  assert.equal(collected.json.complete, true)
  assert.ok(collected.json.posts.length > 0)

  const comments = await server.call('get_comments', { post_ids: [collected.json.posts[0].id], per_post: 3 })
  assert.equal(comments.isError, false, comments.text)
  assert.equal(comments.json.threads.length, 1)
  t.diagnostic(`rate limit after test: ${JSON.stringify(comments.json.rate_limit)}`)
})
