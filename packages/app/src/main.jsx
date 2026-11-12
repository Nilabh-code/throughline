/**
 * Throughline — the board app.
 *
 * The shell that turns a board module into a standalone app.
 *
 *   module.register(ctx)  ->  registrations in three areas
 *   ROUTES_AREA           ->  the page, rendered at its own path
 *   SIDEBAR_NAV_AREA      ->  a rail button
 *   PALETTE_AREA          ->  a command (exposed on window.throughline.palette for now)
 *
 * Everything the module asks the host for is provided here: synchronous storage,
 * the engine's REST + RPC lanes, an OS facade, and disposal.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import plugin from '@throughline/board-module'
import {
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  $toasts,
  setBoardScope,
  useValue
} from '@throughline/board-host'

import './shell.css'
import { installScrollZoom } from './scroll-zoom.js'
import { Bots } from './bots.jsx'

// --------------------------------------------------------------- storage ---

/** Synchronous, like the SDK's: the plugin hydrates in register(). */
const storage = {
  get(key, fallback = null) {
    const raw = localStorage.getItem(`throughline:${key}`)
    if (raw == null) return fallback
    try {
      return JSON.parse(raw)
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`throughline:${key}`, JSON.stringify(value))
      // The page writes its board index on every save and every board switch.
      // That index is the only place the active board id is announced, so the
      // scope follows it — one agent session per board, a new one per new board.
      if (key === 'boards-v1' && value?.activeId) setBoardScope(value.activeId)
    } catch (error) {
      console.warn('[storage] set failed', key, error)
    }
  },
  remove(key) {
    localStorage.removeItem(`throughline:${key}`)
  }
}

// ------------------------------------------------------------------- rest ---

// ctx.rest — the engine's boards/sharing/inbox lane, same paths a module uses.
import { rest } from './rest.js'

// --------------------------------------------------------------------- os ---

const os = {
  async openExternal(url) {
    window.open(url, '_blank', 'noopener,noreferrer')
  },
  async writeClipboard(text) {
    await navigator.clipboard.writeText(text)
    return true
  },
  /** Save dialog → browser download. The page hands us content and a filename. */
  async pickSavePath({ suggestedName, content, mime } = {}) {
    const name = suggestedName || 'board.md'
    if ('showSaveFilePicker' in window) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name })
        const writable = await handle.createWritable()
        await writable.write(content)
        await writable.close()
        return handle.name
      } catch (error) {
        if (error?.name === 'AbortError') return null
      }
    }
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' })
    const href = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = href
    link.download = name
    link.click()
    setTimeout(() => URL.revokeObjectURL(href), 2000)
    return name
  }
}

// -------------------------------------------------------------- register ---

const registrations = []
const disposers = []

const ctx = {
  storage,
  os,
  rest,
  onDispose: (fn) => {
    if (typeof fn === 'function') disposers.push(fn)
  },
  register: (entry) => registrations.push(entry),
  registerMany: (entries) => registrations.push(...(Array.isArray(entries) ? entries : [entries]))
}

try {
  plugin.register(ctx)
} catch (error) {
  console.error('[throughline] board module failed to register', error)
  document.body.innerHTML = `<pre style="padding:24px;color:#f88;white-space:pre-wrap">Board module failed to register:\n\n${error?.stack || error}</pre>`
  throw error
}

const ofArea = (area) => registrations.filter((entry) => entry?.area === area)
const routes = ofArea(ROUTES_AREA)
const navEntries = ofArea(SIDEBAR_NAV_AREA)
const palette = ofArea(PALETTE_AREA)

window.throughline = { registrations, routes, navEntries, palette, storage, rest, os }

// The board the page hydrated on boot is already the scope.
const hydrated = storage.get('boards-v1', null)
if (hydrated?.activeId) setBoardScope(hydrated.activeId)

// ---------------------------------------------------------------- render ---

function useRoute() {
  const [path, setPath] = useState(() => location.pathname)
  useEffect(() => {
    const onPop = () => setPath(location.pathname)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next) => {
    history.pushState({}, '', next)
    setPath(next)
  }, [])
  return [path, go]
}

/**
 * Which ACP agent the board's actions go to. The page itself never names an
 * agent — it calls host.request and the bridge decides — so the choice lives
 * here and is sent as `agent.select`.
 */
function Coworker() {
  const [agents, setAgents] = useState([])
  const [selected, setSelected] = useState(() => localStorage.getItem('throughline:agent') || 'hermes')

  useEffect(() => {
    fetch('/agents')
      .then((r) => r.json())
      .then((data) => setAgents(Array.isArray(data?.agents) ? data.agents : []))
      .catch(() => setAgents([]))
  }, [])

  const choose = async (id) => {
    setSelected(id)
    localStorage.setItem('throughline:agent', id)
    try {
      await rest('/rpc', { method: 'POST', body: { jsonrpc: '2.0', id: 'agent-select', method: 'agent.select', params: { agent: id } } })
    } catch (error) {
      console.warn('[throughline] agent.select failed', error)
    }
  }

  // Tell the bridge on load too — it forgets on restart.
  useEffect(() => {
    if (selected) void choose(selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (agents.length < 2) return null

  return (
    <label className="coworker" title="Which agent does the work">
      <span>agent</span>
      <select value={selected} onChange={(event) => void choose(event.target.value)}>
        {agents.map((agent) => (
          <option key={agent.id} value={agent.id}>
            {agent.label || agent.id}
          </option>
        ))}
      </select>
    </label>
  )
}

function Toasts() {
  const toast = useValue($toasts)
  const [visible, setVisible] = useState(null)
  useEffect(() => {
    if (!toast) return
    setVisible(toast)
    const timer = setTimeout(() => setVisible(null), 4200)
    return () => clearTimeout(timer)
  }, [toast])
  if (!visible) return null
  return <div className="toast" data-kind={visible.kind === 'error' ? 'error' : 'info'}>{visible.message}</div>
}

function App() {
  const [path, go] = useRoute()
  const route = routes.find((entry) => entry?.data?.path === path) || routes[0]
  const stageRef = useRef(null)

  useEffect(() => {
    if (routes.length && path === '/' && routes[0]?.data?.path) go(routes[0].data.path)
  }, [path, go])

  // Plain wheel zooms the board (the page pans on wheel and zooms only with a
  // modifier; this rewrites the gesture rather than editing the page).
  useEffect(() => installScrollZoom(stageRef.current), [])

  return (
    <div className="shell">
      <nav className="rail">
        <div className="brand" title="Throughline">T</div>
        <button
          type="button"
          title="Bots"
          aria-pressed={path === '/bots'}
          onClick={() => go('/bots')}
        >
          🤖
        </button>
        {navEntries.map((entry) => (
          <button
            key={entry.id || entry.data?.path}
            type="button"
            title={entry.data?.label || entry.data?.path}
            aria-pressed={route?.data?.path === entry.data?.path}
            onClick={() => go(entry.data?.path)}
          >
            {entry.data?.codicon === 'lightbulb-sparkle' ? '✦' : '•'}
          </button>
        ))}
        <Coworker />
      </nav>
      <main className="stage" ref={stageRef}>
        {path === '/bots' ? <Bots /> : route ? route.render() : <p style={{ padding: 20 }}>No page registered.</p>}
      </main>
      <Toasts />
    </div>
  )
}

createRoot(document.getElementById('root')).render(<App />)
