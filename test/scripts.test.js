import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { TEST_CREDENTIALS, loadFixture, startFakeReddit } from './fake-reddit.js'

const run = promisify(execFile)
const CHECK = fileURLToPath(new URL('../scripts/check-connection.js', import.meta.url))
const fixture = loadFixture(fileURLToPath(new URL('./fixtures/synthetic.json', import.meta.url)))
const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, REDDIT_SENTIMENT_NO_KEYCHAIN: '1' }

test('npm run check reports a working connection', async (t) => {
  const fake = await startFakeReddit(fixture)
  t.after(fake.close)
  const env = {
    ...baseEnv,
    REDDIT_API_BASE: fake.apiBase,
    REDDIT_AUTH_URL: fake.authUrl,
    REDDIT_CLIENT_ID: TEST_CREDENTIALS.clientId,
    REDDIT_CLIENT_SECRET: TEST_CREDENTIALS.clientSecret,
    REDDIT_USERNAME: TEST_CREDENTIALS.username,
  }
  const { stdout } = await run(process.execPath, [CHECK], { env })
  assert.match(stdout, /Connected to the Reddit Data API/)
  assert.match(stdout, /clientSecret from environment/)
  assert.doesNotMatch(stdout, /test-secret/, 'never prints the secret')
})

test('npm run check fails with the setup steps when credentials are missing', async () => {
  await assert.rejects(run(process.execPath, [CHECK], { env: baseEnv }), (error) => {
    assert.equal(error.code, 1)
    assert.match(error.stderr, /credentials missing/)
    assert.match(error.stderr, /security add-generic-password/)
    return true
  })
})
