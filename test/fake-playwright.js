// A stand-in for playwright-cli attached to Chrome: `goto` remembers the URL and `eval` answers with
// the page Reddit would show for it, taken from a fixture. Used in-process by the unit tests and as a
// command by test/fake-playwright-cli.js.

import { fixtureKey, shiftTimes } from './fake-reddit.js'

const PRIVATE = new Set(['privatecampers'])

// options: block (Reddit shows a block page), rateLimited (every page answers 429), noExtension (attach fails)
function page(fixture, url, options) {
  if (options.block) return "You've been blocked by network security."
  if (options.rateLimited) return JSON.stringify({ message: 'Too Many Requests', error: 429 })
  const target = new URL(url)
  const path = target.pathname.replace(/\.json$/, '')
  const community = path.match(/^\/r\/([^/]+)/)?.[1]
  if (community && PRIVATE.has(community)) return JSON.stringify({ reason: 'private', message: 'Forbidden', error: 403 })
  const body = fixture.responses[fixtureKey(path, target.searchParams)]
  if (body === undefined) return JSON.stringify({ message: 'Not Found', error: 404 })
  return JSON.stringify(shiftTimes(body, Math.round(Date.now() / 1000 - fixture._recorded_utc)))
}

// One playwright-cli invocation. state carries { attached, url, commands } between calls.
export function handle(fixture, state, args, options = {}) {
  state.commands = [...(state.commands ?? []), args.join(' ')]
  const [command, ...params] = args.filter((arg) => !arg.startsWith('-s=') && arg !== '--raw')
  if (command === 'attach') {
    if (options.noExtension) throw new Error('Playwright extension is not connected')
    state.attached = true
    return ''
  }
  if (!state.attached) throw new Error("The browser 'reddit-sentiment' is not open, please run open first")
  if (command === 'goto') {
    state.url = params[0]
    return ''
  }
  if (command === 'eval') return params[0] === '1' ? '1\n' : `${JSON.stringify(page(fixture, state.url, options))}\n`
  throw new Error(`Unknown command: ${command}`)
}

export function createFakeRun(fixture, options = {}) {
  const state = { attached: Boolean(options.attached) }
  return {
    state,
    run: async (args) => handle(fixture, state, args, options),
  }
}
