#!/usr/bin/env node
/**
 * Throughline engine — one process, every coding agent, two front doors.
 *
 *   agent side (upstream, stdio):  ACP — hermes acp, opencode acp,
 *                                  @agentclientprotocol/codex-acp,
 *                                  @agentclientprotocol/claude-agent-acp
 *   board side (downstream, HTTP): /rpc  + /events   — the JSON-RPC verbs a
 *                                  board module already calls
 *                                  (host.request / host.onEvent)
 *   world side (downstream, HTTP): /ag-ui/:agent     — AG-UI SSE runs, so any
 *                                  workspace can register each ACP agent as a
 *                                  remote agent
 *
 * Nothing here knows about a specific agent. Point it at a command.
 *
 *   node src/server.mjs [--port 8790] [--config agents.json]
 */
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'

// ---------------------------------------------------------------- config ---

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const PORT = Number(arg('port', process.env.CANVAS_PORT || 8790))
const HOST = arg('host', process.env.CANVAS_HOST || '127.0.0.1')
const CONFIG_PATH = arg('config', process.env.CANVAS_AGENTS || 'agents.json')

const loadConfig = async () => {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
    const agents = Array.isArray(raw) ? raw : raw.agents
    return { agents: agents.filter((a) => a.enabled !== false) }
  } catch (error) {
    console.error(`[config] ${CONFIG_PATH}: ${error.message} — serving zero agents`)
    return { agents: [] }
  }
}

/**
 * Windows spawns a `.exe` through CreateProcess and nothing else, so every npm-installed CLI
 * (`opencode`, `claude`, `npx`) has to go through the shell to find its `.cmd` shim. Absolute
 * `.exe` paths — like hermes-acp — are spawned directly, which keeps their stdio clean.
 */
const resolveCommand = (command, args = []) => {
  if (process.platform !== 'win32') return { cmd: command, args, shell: false }
  const shellOnly = !!command.match(/\.(cmd|bat)$/i)
  const bare = !/^([a-z]:[\\/]|[\\/])/i.test(command)
  const exe = /\.exe$/i.test(command)
  if (bare && !exe) {
    // A bare name has to go through cmd.exe on Windows, which pollutes the
    // JSON-RPC stream with the shell's own output. Prefer the real .exe that
    // `where` finds; fall back to the shell only for .cmd shims.
    const resolved = whichExecutable(command)
    if (resolved) return { cmd: resolved, args, shell: false }
  }
  return { cmd: command, args, shell: shellOnly || (bare && !exe) }
}

/** The first .exe on PATH for a bare command name, or null. */
const whichExecutable = (command) => {
  try {
    const out = execFileSync('where', [command], { encoding: 'utf8', windowsHide: true })
    const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    return lines.find((line) => /\.exe$/i.test(line)) || null
  } catch {
    return null
  }
}

const textOf = (content) => {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || part?.content || ''))
      .join('')
  }
  return String(content.text ?? '')
}

// ------------------------------------------------------------- ACP agent ---

class AgentBridge {
  constructor(spec) {
    this.spec = spec
    this.id = spec.id
    // ACP sessions take absolute paths; "." in a config is resolved once here.
    this.cwd = path.resolve(spec.cwd || process.cwd())
    this.proc = null
    this.conn = null
    this.init = null
    this.starting = null
    this.sessions = new Map()
    this.listeners = new Set()
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* a dead SSE client must not kill the run */
      }
    }
  }

  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async start() {
    if (this.starting) return this.starting
    this.starting = (async () => {
      const { cmd, args, shell } = resolveCommand(this.spec.command, this.spec.args)
      const proc = spawn(cmd, args, {
        cwd: this.cwd,
        env: { ...process.env, ...(this.spec.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell
      })
      proc.on('error', (error) => this.emit({ type: 'error', agent: this.id, message: error.message }))
      proc.stderr.on('data', (chunk) => {
        const text = String(chunk)
        this.lastStderr = `${this.lastStderr || ''}${text}`.slice(-2000)
        if (process.env.CANVAS_DEBUG) process.stderr.write(`[${this.id}] ${text}`)
      })
      proc.on('exit', (code) => {
        this.emit({ type: 'error', agent: this.id, message: `agent exited (code ${code})`, detail: this.lastStderr })
        this.proc = null
        this.conn = null
        this.starting = null
        this.sessions.clear()
      })

      const stream = ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout))
      const conn = client({ name: `throughline-host/${this.id}` })
        .onRequest('session/request_permission', (ctx) => this.permission(ctx.params))
        .onRequest('fs/read_text_file', async (ctx) => ({
          content: await readFile(ctx.params.path, 'utf8')
        }))
        .onRequest('fs/write_text_file', async (ctx) => {
          await writeFile(ctx.params.path, ctx.params.content ?? '', 'utf8')
          return {}
        })
        .connect(stream)

      this.proc = proc
      this.conn = conn
      this.init = await conn.agent.request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
        clientInfo: { name: 'throughline-host', version: '0.1.0' }
      })
      this.emit({ type: 'agent.ready', agent: this.id, protocolVersion: this.init?.protocolVersion })
      return this
    })()
    try {
      return await this.starting
    } catch (error) {
      this.starting = null
      throw error
    }
  }

  /**
   * Nobody is watching an approval prompt inside a run, so answer it the way the
   * board's own agents do: take the once-scoped allow when the agent offers one,
   * otherwise treat it as refused. `permission: "deny"` in the spec forces deny.
   */
  permission(params) {
    const options = params?.options || []
    const allow =
      this.spec.permission === 'deny'
        ? null
        : options.find((o) => o.kind === 'allow_once') || options.find((o) => String(o.kind || '').startsWith('allow'))
    this.emit({
      type: 'permission.request',
      agent: this.id,
      toolCallId: params?.toolCall?.toolCallId,
      title: params?.toolCall?.title,
      answered: allow ? allow.optionId : 'cancelled'
    })
    return allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } }
  }

  async session(threadId) {
    await this.start()
    let session = this.sessions.get(threadId)
    if (!session) {
      session = await this.conn.agent.buildSession(this.cwd).start()
      this.sessions.set(threadId, session)
    }
    return session
  }

  async cancel(threadId) {
    const session = this.sessions.get(threadId)
    if (!session || !this.conn) return { cancelled: false }
    await this.conn.agent.notify('session/cancel', { sessionId: session.sessionId })
    return { cancelled: true }
  }

  /** Yields `{kind:"update", update}` per ACP session/update, then `{kind:"stop", stopReason}`. */
  async *run(threadId, text) {
    const session = await this.session(threadId)
    const done = session.prompt(text)
    done.catch(() => {}) // surfaced through the loop's own rejections
    for (;;) {
      const message = await session.nextUpdate()
      if (message.kind === 'stop') {
        await done
        yield { kind: 'stop', stopReason: message.stopReason, response: message.response }
        return
      }
      yield { kind: 'update', update: message.update }
    }
  }

  dispose() {
    try {
      this.conn?.close()
    } catch {}
    try {
      this.proc?.kill()
    } catch {}
  }

  /** Drop one cached ACP session, so the next prompt starts a fresh conversation. */
  reset(threadId) {
    const session = this.sessions.get(threadId)
    if (!session) return false
    try {
      session.dispose()
    } catch {}
    this.sessions.delete(threadId)
    return true
  }
}

const bridges = new Map()
const bridgeFor = (id) => {
  const found = bridges.get(id)
  if (!found) throw new Error(`unknown agent: ${id}`)
  return found
}

// ------------------------------------------------------------------ AG-UI ---

const sseHead = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*'
  })
}

const sseSend = (res, event) => {
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

/** One AG-UI run: POST RunAgentInput, stream AG-UI events back as SSE. */
async function runAgent(res, bridge, input) {
  const threadId = input.threadId || randomUUID()
  const runId = input.runId || randomUUID()
  const lastUser = [...(input.messages || [])].reverse().find((m) => m.role === 'user')
  const prompt = textOf(lastUser?.content) || ''

  sseHead(res)
  sseSend(res, { type: 'RUN_STARTED', threadId, runId })
  if (!prompt) {
    sseSend(res, { type: 'RUN_FINISHED', threadId, runId, result: { reason: 'empty prompt' } })
    return res.end()
  }

  const messageId = randomUUID()
  let opened = false
  const ensureText = () => {
    if (!opened) {
      opened = true
      sseSend(res, { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' })
    }
  }
  const toolCalls = new Set()

  try {
    for await (const chunk of bridge.run(threadId, prompt)) {
      if (chunk.kind === 'stop') {
        if (opened) sseSend(res, { type: 'TEXT_MESSAGE_END', messageId })
        sseSend(res, { type: 'RUN_FINISHED', threadId, runId, result: { stopReason: chunk.stopReason } })
        return res.end()
      }
      const update = chunk.update
      const kind = update?.sessionUpdate

      if (kind === 'agent_message_chunk') {
        const text = textOf(update.content)
        if (text) {
          ensureText()
          sseSend(res, { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text })
        }
      } else if (kind === 'agent_thought_chunk') {
        const text = textOf(update.content)
        if (text) sseSend(res, { type: 'REASONING_MESSAGE_CONTENT', messageId, delta: text })
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = update.toolCallId
        if (!toolCalls.has(id)) {
          toolCalls.add(id)
          sseSend(res, {
            type: 'TOOL_CALL_START',
            toolCallId: id,
            toolCallName: update.kind || update.title || 'tool'
          })
        }
        if (update.rawInput) {
          sseSend(res, { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify(update.rawInput) })
        }
        if (update.status === 'completed' || update.status === 'failed') {
          sseSend(res, { type: 'TOOL_CALL_END', toolCallId: id })
        }
      } else if (kind === 'plan' || kind === 'available_commands_update' || kind === 'config_option_update') {
        sseSend(res, { type: 'CUSTOM', name: kind, value: update })
      }
    }
  } catch (error) {
    const detail = bridge.lastStderr ? `\n${bridge.lastStderr.slice(-600)}` : ''
    sseSend(res, { type: 'RUN_ERROR', message: `${error?.message || String(error)}${detail}` })
    res.end()
  }
}

// ------------------------------------------------------- board RPC + events ---

/** Which ACP agent board verbs go to when the page does not name one. */
let defaultAgent = 'hermes'

/** One conversation per board: `${boardId}:${agent}` → stable session id. */
const boardSessions = new Map()
const sessionScope = new Map()

/** The verbs a board module's agent loop speaks. */
async function handleRpc(method, params, boardId = null) {
  const agentId = params?.agent || params?.agent_id || defaultAgent
  const bridge = bridgeFor(agentId)
  const sessionId = params?.session_id || params?.sessionId

  switch (method) {
    case 'agent.list':
      return {
        agents: [...bridges.values()].map((b) => ({ id: b.id, label: b.spec.label || b.id })),
        selected: defaultAgent
      }

    case 'agent.select': {
      const wanted = String(params?.agent || params?.agent_id || '')
      if (!bridges.has(wanted)) throw new Error(`unknown agent: ${wanted}`)
      defaultAgent = wanted
      return { selected: defaultAgent }
    }

    case 'session.create': {
      // The page asks for a hidden session before every command. Answer with the
      // board's existing conversation instead of a new one, so successive
      // commands on a board build on each other. A new board => a new key => a
      // new session, which is the switch the person expects.
      const key = boardId ? `${boardId}:${agentId}` : null
      const existing = key ? boardSessions.get(key) : null
      if (existing) return { session_id: existing, agent: agentId, hidden: true, reused: true }

      const session_id = randomUUID()
      if (key) boardSessions.set(key, session_id)
      sessionScope.set(session_id, { board: boardId, agent: agentId })
      return { session_id, agent: agentId, hidden: Boolean(params?.hidden), reused: false }
    }

    case 'session.reset': {
      const scope = sessionScope.get(sessionId)
      if (scope?.board) boardSessions.delete(`${scope.board}:${scope.agent}`)
      sessionScope.delete(sessionId)
      bridge.reset(sessionId)
      return { reset: true }
    }

    case 'session.set_hidden':
      return { session_id: sessionId, hidden: Boolean(params?.hidden) }

    case 'session.interrupt':
      return await bridge.cancel(sessionId)

    case 'approval.pending':
      return { approvals: [] } // approvals are answered inside the run (see AgentBridge.permission)

    case 'approval.respond':
      return { responded: true, choice: params?.choice || 'deny' }

    case 'prompt.submit': {
      const text = params?.text || ''
      if (!text) throw new Error('prompt.submit needs text')
      void streamToEvents(bridge, sessionId, text)
      return { accepted: true, session_id: sessionId }
    }

    default:
      throw Object.assign(new Error(`unknown method: ${method}`), { code: -32601 })
  }
}

const subscribers = new Set()

/** Fan a host event out to every open /events stream. */
function broadcast(event) {
  for (const deliver of subscribers) {
    try {
      deliver(event)
    } catch {
      subscribers.delete(deliver)
    }
  }
}

/**
 * Runs a prompt and republishes it as the host events the board subscribes to.
 *
 * Shape is the page's contract (plugin.js runSession): every event carries a
 * `payload` object — `message.complete` → payload.text, `tool.start` →
 * payload.name/.args, `error` → payload.message — and a `session_id`.
 */
async function streamToEvents(bridge, sessionId, text) {
  let buffer = ''
  const toolNames = new Map()
  try {
    for await (const chunk of bridge.run(sessionId, text)) {
      if (chunk.kind === 'stop') {
        broadcast({
          type: 'message.complete',
          session_id: sessionId,
          payload: {
            text: buffer,
            content: buffer,
            outcome: chunk.stopReason === 'end_turn' ? 'completed' : chunk.stopReason
          }
        })
        void logRun(sessionId, text, buffer)
        return
      }
      const update = chunk.update
      const kind = update?.sessionUpdate
      if (kind === 'agent_message_chunk') {
        const piece = textOf(update.content)
        buffer += piece
        if (piece) broadcast({ type: 'message.delta', session_id: sessionId, payload: { text: piece } })
      } else if (kind === 'tool_call' || kind === 'tool_call_update') {
        const id = update.toolCallId
        if (!toolNames.has(id)) {
          const name = update.kind || update.title || 'tool'
          toolNames.set(id, name)
          broadcast({
            type: 'tool.start',
            session_id: sessionId,
            payload: { name, tool_name: name, title: update.title, args: update.rawInput || {} }
          })
        }
        if (update.status === 'completed' || update.status === 'failed') {
          broadcast({
            type: 'tool.end',
            session_id: sessionId,
            payload: { tool_call_id: id, status: update.status }
          })
        }
      }
    }
  } catch (error) {
    broadcast({ type: 'error', session_id: sessionId, payload: { message: error?.message || String(error) } })
  }
}

// -------------------------------------------------------------------- http ---

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 8 * 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON: ${error.message}`))
      }
    })
    req.on('error', reject)
  })

const json = (res, status, value) => {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}

const URL_BASE = `http://${HOST}:${PORT}`
const CONSOLE_FILE = new URL('./console.html', import.meta.url)

// ---- boards lane: what the board module persists through ctx.rest ----------
import { mkdir, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = process.env.CANVAS_DATA || path.resolve(process.cwd(), '.throughline')
const BOARDS_DIR = path.join(DATA_DIR, 'boards')
const INBOX_DIR = path.join(DATA_DIR, 'inbox')
const SHARING_FILE = path.join(DATA_DIR, 'sharing.json')
const BOARD_ID = /^[A-Za-z0-9_-]{1,64}$/

const ensureDirs = async () => {
  await mkdir(BOARDS_DIR, { recursive: true })
  await mkdir(INBOX_DIR, { recursive: true })
}
const readJson = async (file, fallback = null) => {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}
const writeJson = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(value), 'utf8')
}

/** Dev aid: the last board run, prompt and reply, on disk to inspect. */
const logRun = async (sessionId, prompt, reply) => {
  try {
    await writeJson(path.join(DATA_DIR, 'last-run.json'), { at: new Date().toISOString(), sessionId, prompt, reply })
  } catch {
    /* diagnostics must never break a run */
  }
}

/** The page's own storage paths, kept: /boards/:id, /sharing, /inbox. */
async function handleBoards(req, res, url) {
  await ensureDirs()

  if (url.pathname === '/sharing') {
    if (req.method === 'POST') {
      const body = await readBody(req)
      await writeJson(SHARING_FILE, { on: Boolean(body?.on), at: Date.now() / 1000 })
      return json(res, 200, { ok: true, on: Boolean(body?.on) })
    }
    const current = await readJson(SHARING_FILE, { on: false })
    return json(res, 200, { ok: true, on: Boolean(current?.on) })
  }

  if (url.pathname === '/inbox') {
    const entries = []
    for (const name of await readdir(INBOX_DIR)) {
      if (!name.startsWith('w') || !name.endsWith('.json')) continue
      const entry = await readJson(path.join(INBOX_DIR, name))
      if (entry?.id) entries.push(entry)
    }
    return json(res, 200, { ok: true, entries })
  }

  if (url.pathname.startsWith('/inbox/')) {
    const id = decodeURIComponent(url.pathname.split('/')[2] || '')
    if (!/^w[0-9a-f]{12}$/.test(id)) return json(res, 400, { error: 'bad entry id' })
    await unlink(path.join(INBOX_DIR, `${id}.json`)).catch(() => {})
    return json(res, 200, { ok: true })
  }

  const id = decodeURIComponent(url.pathname.replace(/^\/boards\/?/, ''))
  if (!id) {
    const boards = []
    for (const name of await readdir(BOARDS_DIR)) {
      if (!name.endsWith('.json')) continue
      const board = await readJson(path.join(BOARDS_DIR, name))
      if (board?.id) boards.push({ id: board.id, name: board.name, updatedAt: board.updatedAt })
    }
    return json(res, 200, { ok: true, boards })
  }
  if (!BOARD_ID.test(id)) return json(res, 400, { error: 'bad board id' })
  const file = path.join(BOARDS_DIR, `${id}.json`)

  if (req.method === 'GET') {
    const board = await readJson(file)
    return board ? json(res, 200, board) : json(res, 404, { error: 'no such board' })
  }
  if (req.method === 'PUT' || req.method === 'POST') {
    const body = await readBody(req)
    if (body?.id && body.id !== id) return json(res, 400, { error: 'board id mismatch' })
    await writeJson(file, { ...body, id })
    return json(res, 200, { ok: true })
  }
  return json(res, 405, { error: 'method not allowed' })
}

// ---- the board: the built app, served by this same process -----------------
const DIST_DIR = process.env.THROUGHLINE_DIST || fileURLToPath(new URL('../../app/dist/', import.meta.url))
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8'
}

async function serveBoard(req, res, url) {
  // The app mounts at /board/; a board module may own its own route, which also
  // has to serve the app shell.
  if (url.pathname === '/board') {
    res.writeHead(302, { Location: '/board/' })
    return res.end()
  }
  const relative = url.pathname.startsWith('/board/') ? url.pathname.slice('/board/'.length) : ''
  const candidate = path.join(DIST_DIR, relative || 'index.html')
  const insideDist = path.resolve(candidate).startsWith(path.resolve(DIST_DIR))

  if (insideDist && relative) {
    try {
      const file = await readFile(candidate)
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(candidate)] || 'application/octet-stream',
        'Content-Length': file.length,
        'Cache-Control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store'
      })
      return res.end(file)
    } catch {
      /* fall through to the SPA entry */
    }
  }
  try {
    const html = await readFile(path.join(DIST_DIR, 'index.html'))
    res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': html.length, 'Cache-Control': 'no-store' })
    return res.end(html)
  } catch (error) {
    return json(res, 503, {
      error: `board not built: ${error.message}`,
      hint: 'cd packages/app && npm install && npm run build'
    })
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

  if (req.method === 'GET' && url.pathname.startsWith('/board')) {
    return serveBoard(req, res, url)
  }

  // The boards lane — the page's ctx.rest targets these paths.
  if (
    url.pathname === '/sharing' ||
    url.pathname === '/inbox' ||
    url.pathname.startsWith('/inbox/') ||
    url.pathname === '/boards' ||
    url.pathname.startsWith('/boards/')
  ) {
    try {
      return await handleBoards(req, res, url)
    } catch (error) {
      return json(res, 500, { error: error.message })
    }
  }

  // The console: one self-contained page, no build step.
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/console')) {
    try {
      const html = await readFile(CONSOLE_FILE, 'utf8')
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store'
      })
      return res.end(html)
    } catch (error) {
      return json(res, 500, { error: `console.html: ${error.message}` })
    }
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    })
    return res.end()
  }

  if (url.pathname === '/health') {
    return json(res, 200, {
      ok: true,
      service: 'throughline-engine',
      agents: [...bridges.values()].map((b) => ({
        id: b.id,
        label: b.spec.label || b.id,
        command: b.spec.command,
        running: Boolean(b.proc),
        sessions: b.sessions.size,
        protocolVersion: b.init?.protocolVersion ?? null
      })),
      agUiRoutes: [...bridges.keys()].map((id) => `/ag-ui/${id}`),
      boards: [...boardSessions.entries()].map(([key, session]) => ({ key, session })),
      defaultAgent
    })
  }

  if (url.pathname === '/agents') {
    return json(res, 200, {
      agents: [...bridges.values()].map((b) => ({
        id: b.id,
        label: b.spec.label || b.id,
        description: b.spec.description || '',
        agUiEndpoint: `/ag-ui/${b.id}`
      }))
    })
  }

  // AG-UI: POST RunAgentInput -> SSE of AG-UI events. Path form: /ag-ui/<agent>
  if (req.method === 'POST' && url.pathname.startsWith('/ag-ui')) {
    const id = decodeURIComponent(url.pathname.split('/')[2] || 'hermes')
    try {
      const bridge = bridgeFor(id)
      const input = await readBody(req)
      return await runAgent(res, bridge, input)
    } catch (error) {
      return json(res, 404, { error: error.message })
    }
  }

  // Board events: GET /events (SSE) or /events?session=<id>
  if (req.method === 'GET' && url.pathname === '/events') {
    const only = url.searchParams.get('session')
    sseHead(res)
    sseSend(res, { type: 'ready' })
    const deliver = (event) => {
      if (only && event.session_id && event.session_id !== only) return
      sseSend(res, event)
    }
    subscribers.add(deliver)
    req.on('close', () => {
      subscribers.delete(deliver)
      try {
        res.end()
      } catch {}
    })
    return
  }

  // Board RPC: JSON-RPC 2.0 {id, method, params}
  if (req.method === 'POST' && url.pathname === '/rpc') {
    let payload
    try {
      payload = await readBody(req)
    } catch (error) {
      return json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: error.message } })
    }
    const { id = null, method, params = {} } = payload
    const boardId = req.headers['x-throughline-board'] || payload.board || null
    try {
      const result = await handleRpc(method, params, boardId)
      return json(res, 200, { jsonrpc: '2.0', id, result })
    } catch (error) {
      return json(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: error.code || -32000, message: error.message }
      })
    }
  }

  // Anything else a browser navigates to is the app's own router (a board module
  // may register routes we do not know about).
  if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
    return serveBoard(req, res, url)
  }

  return json(res, 404, { error: 'not found', routes: ['/', '/health', '/agents', '/ag-ui/:agent', '/rpc', '/events'] })
})

// -------------------------------------------------------------------- boot ---

const config = await loadConfig()
for (const spec of config.agents) {
  if (!spec?.id || !spec?.command) {
    console.error(`[config] skipping an entry without id/command: ${JSON.stringify(spec)}`)
    continue
  }
  bridges.set(spec.id, new AgentBridge(spec))
}

server.listen(PORT, HOST, () => {
  console.log(`throughline engine  http://${HOST}:${PORT}`)
  for (const bridge of bridges.values()) {
    console.log(`  agent ${bridge.id.padEnd(10)} ${bridge.spec.command} ${(bridge.spec.args || []).join(' ')}`)
    console.log(`    AG-UI  POST http://${HOST}:${PORT}/ag-ui/${bridge.id}`)
  }
  console.log(`  board  POST /rpc   GET /events`)
})

const shutdown = () => {
  for (const bridge of bridges.values()) bridge.dispose()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
