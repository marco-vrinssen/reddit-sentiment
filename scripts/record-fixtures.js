// Records real Data API responses to test/fixtures/recorded.json, which test/recorded.test.js replays.
// Needs the same credentials as the plugin. About 7 API calls.
// Usage: npm run record

import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCredentials } from '../plugin/server/credentials.js'
import { createRedditClient, listing } from '../plugin/server/reddit.js'
import { fixtureKey } from '../test/fake-reddit.js'

const OUT = fileURLToPath(new URL('../test/fixtures/recorded.json', import.meta.url))

const client = createRedditClient({ credentials: loadCredentials(), maxQpm: 60, log: (m) => console.error(m) })
const responses = {}

async function record(path, params = {}) {
  const body = await client.get(path, params)
  responses[fixtureKey(path, new URLSearchParams(params))] = body
  console.error(`recorded ${path}`)
  return body
}

await record('/subreddits/popular', { limit: 1 })
await record('/subreddits/search', { q: 'camping', limit: 10, sort: 'relevance', include_over_18: 'off' })
await record('/r/camping/about')
await record('/r/camping/new', { limit: 100 })
const top = await record('/r/camping/top', { t: 'month', limit: 100 })
await record('/r/BuyItForLife/search', { q: 'tent', restrict_sr: 'on', sort: 'top', t: 'month', limit: 100 })
const first = listing(top, 't3', '/r/camping/top').items.find((post) => post.num_comments > 5)
if (first) await record(`/comments/${first.id}`, { sort: 'top', limit: 30, depth: 1 })

writeFileSync(OUT, `${JSON.stringify({ _recorded_utc: Math.round(Date.now() / 1000), responses }, null, 1)}\n`)
console.error(`Wrote ${Object.keys(responses).length} responses to ${OUT} (${client.stats().api_calls} API calls)`)
