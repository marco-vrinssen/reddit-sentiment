import { test } from 'node:test'
import assert from 'node:assert/strict'
import { KEYCHAIN_SERVICE, loadCredentials } from '../plugin/server/credentials.js'

const noKeychain = () => null

test('environment first, keychain second, sources reported', () => {
  const keychain = (service, account) => (service === KEYCHAIN_SERVICE && account === 'client-secret' ? 'from-keychain' : null)
  const result = loadCredentials({ env: { REDDIT_CLIENT_ID: 'id', REDDIT_USERNAME: 'owner' }, keychain, version: '1.2.3' })
  assert.equal(result.clientSecret, 'from-keychain')
  assert.deepEqual(result.sources, { clientId: 'environment', clientSecret: 'keychain', username: 'environment' })
  assert.match(result.userAgent, /^\w+:reddit-sentiment:1\.2\.3 \(by \/u\/owner\)$/)
})

test('missing credentials name each field and how to add it', () => {
  assert.throws(
    () => loadCredentials({ env: { REDDIT_CLIENT_ID: '  ' }, keychain: noKeychain }),
    (error) => {
      assert.equal(error.kind, 'credentials')
      assert.equal(error.fatal, true)
      assert.match(error.message, /client id: set REDDIT_CLIENT_ID/)
      assert.match(error.message, /security add-generic-password -s reddit-sentiment -a client-secret -w/)
      assert.match(error.message, /username/)
      return true
    },
  )
})

test('REDDIT_SENTIMENT_NO_KEYCHAIN skips the keychain', () => {
  const keychain = () => 'should-not-be-used'
  assert.throws(() => loadCredentials({ env: { REDDIT_SENTIMENT_NO_KEYCHAIN: '1' }, keychain }), /credentials missing/)
})

test('REDDIT_USER_AGENT overrides the built one', () => {
  const env = { REDDIT_CLIENT_ID: 'a', REDDIT_CLIENT_SECRET: 'b', REDDIT_USERNAME: 'c', REDDIT_USER_AGENT: 'custom:agent:1 (by /u/c)' }
  assert.equal(loadCredentials({ env, keychain: noKeychain }).userAgent, 'custom:agent:1 (by /u/c)')
})
