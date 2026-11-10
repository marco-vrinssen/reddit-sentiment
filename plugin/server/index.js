#!/usr/bin/env node
// MCP server over stdio: newline-delimited JSON-RPC 2.0, no dependencies.

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { loadCredentials } from './credentials.js'
import { RedditError } from './errors.js'
import { createRedditClient } from './reddit.js'
import { createTools } from './tools.js'

const { version } = JSON.parse(readFileSync(new URL('../.claude-plugin/plugin.json', import.meta.url), 'utf8'))
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']
const INSTRUCTIONS =
  "Read-only access to Reddit's official Data API for the sentiment-report skill. Call check_connection first. Every result says whether it is complete; never present partial data as complete."

const log = (message) => process.stderr.write(`[reddit-sentiment] ${message}\n`)

let client = null
function getClient() {
  if (!client) {
    const credentials = loadCredentials({ version })
    client = createRedditClient({
      credentials,
      authUrl: process.env.REDDIT_AUTH_URL || undefined,
      apiBase: process.env.REDDIT_API_BASE || undefined,
      maxQpm: Number(process.env.REDDIT_MAX_QPM) || 100,
      log,
    })
  }
  return client
}

const tools = createTools({ getClient, version })

async function callTool({ name, arguments: args }) {
  try {
    const result = await tools.call(name, args)
    if (result === null) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 })
    return { content: [{ type: 'text', text: JSON.stringify(result) }] }
  } catch (error) {
    if (error.code === -32602) throw error
    if (error instanceof RedditError) {
      if (error.kind === 'credentials') client = null
      return { content: [{ type: 'text', text: error.message }], isError: true }
    }
    log(error.stack)
    return { content: [{ type: 'text', text: `Internal error in reddit-sentiment: ${error.message}` }], isError: true }
  }
}

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'reddit-sentiment', version },
        instructions: INSTRUCTIONS,
      }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: tools.definitions }
    case 'tools/call':
      return callTool(params)
    default:
      throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 })
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handle(message) {
  const { id, method, params } = message ?? {}
  if (id === undefined || id === null || typeof method !== 'string') return
  try {
    send({ jsonrpc: '2.0', id, result: await dispatch(method, params ?? {}) })
  } catch (error) {
    send({ jsonrpc: '2.0', id, error: { code: error.code ?? -32603, message: error.message } })
  }
}

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
    return
  }
  handle(message).catch((error) => log(error.stack))
})
lines.on('close', () => process.exit(0))
