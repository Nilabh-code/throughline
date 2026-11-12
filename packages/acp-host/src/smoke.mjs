#!/usr/bin/env node
/**
 * ACP lane smoke probe.
 *
 * Spawns any ACP agent over stdio (hermes acp, opencode acp, codex-acp,
 * claude-agent-acp), initializes, opens a session and asks one question.
 * Proves the pipe before any bridge/UI work rides on it.
 *
 * usage: node src/smoke.mjs <cmd> [...args]
 */
import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

const [cmd, ...args] = process.argv.slice(2)
if (!cmd) {
  console.error('usage: node src/smoke.mjs <agent-cmd> [...args]')
  process.exit(2)
}

const cwd = process.env.ACP_CWD || process.cwd()
const prompt = process.env.ACP_PROMPT || 'Reply with exactly: ACP OK. Nothing else.'

const proc = spawn(cmd, args, {
  cwd,
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
  // Windows resolves only .exe through CreateProcess; npm CLIs are .cmd shims.
  shell: process.platform === 'win32' && !/^([a-z]:[\\/]|[\\/])/i.test(cmd) && !/\.exe$/i.test(cmd)
})
proc.stderr.on('data', (d) => process.stderr.write(`[agent stderr] ${d}`))
proc.on('error', (e) => console.error('[spawn error]', e.message))
proc.on('exit', (code, sig) => console.error(`[agent exit] code=${code} sig=${sig}`))

const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))

let text = ''
let updates = 0
const seen = new Set()
let sessionId = ''

const bail = setTimeout(() => {
  console.error('TIMEOUT after 120s')
  try { proc.kill() } catch {}
  process.exit(1)
}, 120_000)

try {
  await client({ name: 'throughline-probe' })
    .onRequest('session/request_permission', () => ({ outcome: { outcome: 'cancelled' } }))
    .onRequest('fs/read_text_file', () => ({ content: '' }))
    .onRequest('fs/write_text_file', () => ({}))
    .connectWith(stream, async (ctx) => {
      const init = await ctx.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
        clientInfo: { name: 'throughline-probe', version: '0.1.0' }
      })
      console.log('initialize ->', JSON.stringify(init).slice(0, 600))

      const session = await ctx.buildSession(cwd).start()
      sessionId = session.sessionId
      console.log('session ->', sessionId, 'modes:', JSON.stringify(session.modes)?.slice(0, 200))

      const done = session.prompt(prompt)

      for (;;) {
        const msg = await session.nextUpdate()
        if (msg.kind === 'stop') {
          console.log('stop ->', msg.stopReason)
          break
        }
        updates += 1
        const u = msg.update
        const kind = u?.sessionUpdate
        if (!seen.has(kind)) {
          seen.add(kind)
          console.log('update kind:', kind, '|', JSON.stringify(u).slice(0, 220))
        }
        if (kind === 'agent_message_chunk' && u.content?.type === 'text') text += u.content.text
      }
      await done
      session.dispose()
    })
} catch (e) {
  console.error('FAIL:', e?.stack || e)
} finally {
  clearTimeout(bail)
}

console.log(`updates=${updates} session=${sessionId}`)
console.log('--- agent text ---')
console.log(text)
try { proc.stdin.end() } catch {}
setTimeout(() => { try { proc.kill() } catch {} ; process.exit(0) }, 800)
