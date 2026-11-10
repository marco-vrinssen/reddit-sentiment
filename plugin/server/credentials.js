// Loads the Reddit app credentials from the environment, then the macOS keychain.
// Values are never logged or returned; only where each one came from.

import { execFileSync } from 'node:child_process'
import { RedditError } from './errors.js'

export const KEYCHAIN_SERVICE = 'reddit-sentiment'

const FIELDS = [
  { key: 'clientId', env: 'REDDIT_CLIENT_ID', account: 'client-id', label: 'client id' },
  { key: 'clientSecret', env: 'REDDIT_CLIENT_SECRET', account: 'client-secret', label: 'client secret' },
  { key: 'username', env: 'REDDIT_USERNAME', account: 'username', label: 'Reddit username of the app owner (used in the User-Agent)' },
]

export function readKeychain(service, account) {
  if (process.platform !== 'darwin') return null
  try {
    const value = execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    })
    return value.trim() || null
  } catch {
    return null
  }
}

export function loadCredentials({ env = process.env, keychain = readKeychain, version = '0' } = {}) {
  const useKeychain = env.REDDIT_SENTIMENT_NO_KEYCHAIN !== '1'
  const values = {}
  const sources = {}
  const missing = []

  for (const field of FIELDS) {
    const fromEnv = env[field.env]?.trim()
    if (fromEnv) {
      values[field.key] = fromEnv
      sources[field.key] = 'environment'
      continue
    }
    const fromKeychain = useKeychain ? keychain(KEYCHAIN_SERVICE, field.account) : null
    if (fromKeychain) {
      values[field.key] = fromKeychain
      sources[field.key] = 'keychain'
      continue
    }
    missing.push(field)
  }

  if (missing.length > 0) {
    const lines = missing.map(
      (f) => `- ${f.label}: set ${f.env}, or run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${f.account} -w`,
    )
    throw new RedditError(
      'credentials',
      `Reddit credentials missing. Nothing was scanned.\n${lines.join('\n')}\nA keychain entry counts from the next call. An environment variable needs a Claude Code restart.`,
    )
  }

  const userAgent =
    env.REDDIT_USER_AGENT?.trim() || `${platformName()}:reddit-sentiment:${version} (by /u/${values.username})`

  return { ...values, userAgent, sources }
}

function platformName() {
  return { darwin: 'macos', win32: 'windows' }[process.platform] ?? process.platform
}
