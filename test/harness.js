// Starts the MCP server as a child process and speaks JSON-RPC to it over stdio.

import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const SERVER = fileURLToPath(new URL('../plugin/server/index.js', import.meta.url))

export function startServer(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, REDDIT_SENTIMENT_NO_KEYCHAIN: '1', REDDIT_MAX_QPM: '100000', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const pending = new Map()
  let nextId = 1
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    pending.get(message.id)?.(message)
    pending.delete(message.id)
  })
  const request = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const call = async (name, args = {}) => {
    const { result, error } = await request('tools/call', { name, arguments: args })
    if (error) throw new Error(error.message)
    return { isError: Boolean(result.isError), text: result.content[0].text, json: result.isError ? null : JSON.parse(result.content[0].text) }
  }
  return { request, call, stop: () => child.kill() }
}
