#!/usr/bin/env node
// Command-line stand-in for playwright-cli, for the server tests. State lives in FAKE_PLAYWRIGHT_STATE.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { loadFixture } from './fake-reddit.js'
import { handle } from './fake-playwright.js'

const statePath = process.env.FAKE_PLAYWRIGHT_STATE
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {}
try {
  const out = handle(loadFixture(process.env.FAKE_PLAYWRIGHT_FIXTURE), state, process.argv.slice(2), {
    block: process.env.FAKE_PLAYWRIGHT_BLOCK === '1',
  })
  writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write(out)
} catch (error) {
  writeFileSync(statePath, JSON.stringify(state))
  process.stdout.write(`${error.message}\n`)
  process.exit(1)
}
