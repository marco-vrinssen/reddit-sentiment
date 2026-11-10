// Checks the stored credentials the way the plugin loads them: authenticates and reads one listing.
// Costs 2 API calls. Usage: npm run check

import { readFileSync } from 'node:fs'
import { loadCredentials } from '../plugin/server/credentials.js'
import { createRedditClientFromEnv, listing } from '../plugin/server/reddit.js'

const { version } = JSON.parse(readFileSync(new URL('../plugin/.claude-plugin/plugin.json', import.meta.url), 'utf8'))

try {
  const credentials = loadCredentials({ version })
  const client = createRedditClientFromEnv({ credentials })
  listing(await client.get('/subreddits/popular', { limit: 1 }), 't5', '/subreddits/popular')
  const { rate_limit: rate } = client.stats()
  const sources = Object.entries(credentials.sources).map(([key, source]) => `${key} from ${source}`)
  console.log('Connected to the Reddit Data API.')
  console.log(`User-Agent: ${credentials.userAgent}`)
  console.log(`Credentials: ${sources.join(', ')}`)
  console.log(`Rate limit: ${rate.remaining ?? 'unknown'} requests left, resets in ${rate.resets_in_seconds ?? 'unknown'} s`)
  console.log('Next: start a new Claude Code session and run /reddit-sentiment:industry tents')
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
