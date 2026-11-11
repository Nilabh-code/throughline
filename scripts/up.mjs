#!/usr/bin/env node
/**
 * One command to bring Canvas up: Postgres, then the bridge.
 *
 *   node scripts/up.mjs
 *
 * The portable Postgres cluster under ~/pg does NOT auto-start the way the
 * winget Windows service would, so this exists: it starts the cluster if the
 * port is closed, starts the bridge if 8790 is closed, and prints where things
 * are. Idempotent — safe to run when everything is already up.
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PG_HOME = process.env.CANVAS_PG_HOME || join(process.env.USERPROFILE || process.env.HOME, 'pg', 'pgsql')
const PG_PORT = Number(process.env.CANVAS_PG_PORT || 55432)
const PG_DATA = join(PG_HOME, 'data')
const BRIDGE_PORT = Number(process.env.CANVAS_PORT || 8790)
const BRIDGE_CWD = join(root, 'packages', 'acp-host')

const portOpen = (port, host = '127.0.0.1') =>
  new Promise((resolvePort) => {
    const socket = net.connect({ port, host })
    socket.setTimeout(700)
    socket.once('connect', () => {
      socket.destroy()
      resolvePort(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolvePort(false)
    })
    socket.once('error', () => resolvePort(false))
  })

const waitFor = async (port, ms = 30000) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await new Promise((r) => setTimeout(r, 400))
  }
  return false
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let out = ''
    child.stdout?.on('data', (d) => (out += d))
    child.stderr?.on('data', (d) => (out += d))
    child.once('exit', (code) => resolveRun({ code, out }))
    child.once('error', (error) => resolveRun({ code: -1, out: error.message }))
  })

let failed = false

// 1 — Postgres
if (await portOpen(PG_PORT)) {
  console.log(`postgres  already up on ${PG_PORT}`)
} else {
  const env = { ...process.env, PATH: `${join(PG_HOME, 'bin')};${process.env.PATH}` }
  const started = await run(join(PG_HOME, 'bin', 'pg_ctl.exe'), [
    '-D',
    PG_DATA,
    '-l',
    join(PG_HOME, 'pg.log'),
    '-o',
    `-p ${PG_PORT} -c listen_addresses=127.0.0.1`,
    'start'
  ], { env })
  if (!(await waitFor(PG_PORT))) {
    console.error(`postgres  FAILED to start\n${started.out.slice(-400)}`)
    failed = true
  } else {
    console.log(`postgres  started on ${PG_PORT}`)
  }
}

// 2 — bridge
if (await portOpen(BRIDGE_PORT)) {
  console.log(`bridge    already up on ${BRIDGE_PORT}`)
} else {
  const child = spawn(process.execPath, ['src/server.mjs', '--port', String(BRIDGE_PORT), '--config', 'agents.json'], {
    cwd: BRIDGE_CWD,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  if (!(await waitFor(BRIDGE_PORT))) {
    console.error('bridge    FAILED to start')
    failed = true
  } else {
    console.log(`bridge    started on ${BRIDGE_PORT}`)
  }
}

if (!failed) {
  console.log(`
  board     http://127.0.0.1:${BRIDGE_PORT}/board/
  console   http://127.0.0.1:${BRIDGE_PORT}/
  agents    http://127.0.0.1:${BRIDGE_PORT}/agents
  database  postgres://postgres:***@127.0.0.1:${PG_PORT}/throughline`)
}

process.exit(failed ? 1 : 0)
