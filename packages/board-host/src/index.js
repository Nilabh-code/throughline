/**
 * Throughline — the board host.
 *
 * A board module is a plain ES module that exports `{id, name, description,
 * register(ctx)}`. It asks the host for a small, fixed surface, and this file is
 * that surface — nothing else:
 *
 *   atom, useValue                      state
 *   host.{request,onEvent,notify,...}    the engine's RPC + event lane
 *   icons (12), Tip, Streamdown          rendering
 *   ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA   where a module attaches
 *
 * Contract source of truth: the module's own import line plus its register(ctx)
 * body. Keep this file small enough to read in one sitting.
 */
import { createElement, useSyncExternalStore } from 'react'


// ------------------------------------------------------------------ atoms ---

/** Minimal nanostores-shaped atom: get / set / subscribe. */
export function atom(initial) {
  let value = initial
  const listeners = new Set()
  const api = {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return
      value = next
      for (const listener of [...listeners]) listener(value)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    listen(listener) {
      return api.subscribe(listener)
    }
  }
  return api
}

/** React binding: re-render on every atom change. */
export function useValue(atomLike) {
  return useSyncExternalStore(
    (onChange) => atomLike.subscribe(onChange),
    () => atomLike.get(),
    () => atomLike.get()
  )
}

// ------------------------------------------------------------------- host ---

const eventBus = new Map() // event name -> Set<handler>
const toasts = atom(null)
let eventSource = null
let boardScope = null

/**
 * Which board the page is looking at. The shell sets this from the board index
 * the page writes to storage, and every RPC carries it, so the bridge can keep
 * ONE agent session per board instead of minting a fresh one per command.
 */
export function setBoardScope(boardId) {
  boardScope = boardId || null
  // A board switch is a conversation switch: make sure the events stream we
  // already hold is not filtered by a stale id.
}

const emitLocal = (name, payload) => {
  for (const handler of eventBus.get(name) || []) {
    try {
      handler(payload)
    } catch (error) {
      console.error(`[host.onEvent ${name}]`, error)
    }
  }
}

const connectEvents = () => {
  if (eventSource || typeof EventSource === 'undefined') return
  eventSource = new EventSource('/events')
  eventSource.onmessage = (message) => {
    let event
    try {
      event = JSON.parse(message.data)
    } catch {
      return
    }
    if (!event?.type) return
    emitLocal(event.type, event)
    emitLocal('*', event)
  }
  eventSource.onerror = () => {
    /* EventSource retries on its own; nothing to do */
  }
}

/** JSON-RPC 2.0 against the bridge — the board's `host.request`. */
async function request(method, params = {}) {
  const response = await fetch('/rpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(boardScope ? { 'X-Throughline-Board': boardScope } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params })
  })
  const payload = await response.json()
  if (payload.error) throw new Error(payload.error.message || `${method} failed`)
  return payload.result
}

export const host = {
  request,
  onEvent(name, handler) {
    connectEvents()
    if (!eventBus.has(name)) eventBus.set(name, new Set())
    eventBus.get(name).add(handler)
    return () => eventBus.get(name)?.delete(handler)
  },
  notify({ kind = 'info', message = '' } = {}) {
    toasts.set({ kind, message, at: Date.now() })
  },
  notifyError(error, fallback = 'Something went wrong') {
    toasts.set({ kind: 'error', message: error?.message || fallback, at: Date.now() })
  },
  navigate(path) {
    if (location.pathname === path) return
    history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
}

/** The shell renders this; the page's own toasts land here. */
export const $toasts = toasts

// ------------------------------------------------------------------ areas ---

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const PALETTE_AREA = 'palette'

// ------------------------------------------------------------------ icons ---

const icon = (paths, viewBox = '0 0 24 24') =>
  function Icon({ size = 16, strokeWidth = 1.7 } = {}) {
    return createElement(
      'svg',
      {
        width: size,
        height: size,
        viewBox,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        focusable: false
      },
      paths.map((d, i) => createElement('path', { key: i, d }))
    )
  }

/** What a page gets for an icon this shim does not implement. A missing glyph
 *  must never take the whole board down (React #130 = undefined component). */
const placeholderIcon = icon(['M7 7h10v10H7z'])

const iconMap = {
  ArrowUp: icon(['M12 19V5', 'M6 11l6-6 6 6']),
  ChevronDown: icon(['M6 9l6 6 6-6']),
  Copy: icon(['M9 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2z', 'M5 15V6a2 2 0 0 1 2-2h9']),
  Download: icon(['M12 3v12', 'M7 11l5 5 5-5', 'M4 21h16']),
  Maximize: icon(['M4 9V4h5', 'M20 15v5h-5', 'M20 9V4h-5', 'M4 15v5h5']),
  Pencil: icon(['M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16v4z']),
  Plus: icon(['M12 5v14', 'M5 12h14']),
  Settings: icon(['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3.9a7 7 0 0 0-1.7-1L14.5 3h-5l-.4 2.5a7 7 0 0 0-1.7 1L5 5.6l-2 3.4L5 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.7 1l.4 2.5h5l.4-2.5a7 7 0 0 0 1.7-1l2.3.9 2-3.4-2-1.5c.06-.33.1-.66.1-1z']),
  // The page asks for Trash2 (the digit matters: a regex that stops at [A-Za-z]
  // turns this into "Trash" and ships an icon map that crashes on selection).
  Trash2: icon(['M4 7h16', 'M10 4h4', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6']),
  Trash: icon(['M4 7h16', 'M10 4h4', 'M6 7l1 13h10l1-13', 'M10 11v6', 'M14 11v6']),
  X: icon(['M6 6l12 12', 'M18 6L6 18']),
  ZoomIn: icon(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4', 'M11 8v6', 'M8 11h6']),
  ZoomOut: icon(['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20 20l-4-4', 'M8 11h6'])
}

const warnedIcons = new Set()

export const icons = new Proxy(iconMap, {
  get(target, prop) {
    if (typeof prop !== 'string') return target[prop]
    if (prop in target) return target[prop]
    if (!warnedIcons.has(prop)) {
      warnedIcons.add(prop)
      console.warn(`[plugin-sdk] icons.${prop} is not implemented here; drawing a placeholder`)
    }
    return placeholderIcon
  }
})


// -------------------------------------------------------------------- Tip ---

/** Hermes' tooltip. A title attribute is honest and needs no portal. */
export function Tip({ label, children }) {
  return createElement('span', { className: 'wb-tip', title: label, 'data-tip': label }, children)
}

// ------------------------------------------------------------- Streamdown ---

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const inline = (text) =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>')

/**
 * Markdown, small and synchronous: headings, lists, quotes, fenced code,
 * inline code/bold/italic/links. `controls` is accepted and ignored — the
 * board only ever passes `controls: false`.
 */
export function Streamdown({ children }) {
  const source = String(children ?? '')
  const out = []
  let list = null
  let code = null
  let fence = null

  const closeList = () => {
    if (list) {
      out.push(`<ul>${list.join('')}</ul>`)
      list = null
    }
  }
  const closeCode = () => {
    if (code) {
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
      code = null
    }
  }

  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('```')) {
      if (fence === null) {
        closeList()
        fence = line.slice(3).trim()
        code = []
      } else {
        closeCode()
        fence = null
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    if (!line.trim()) {
      closeList()
      continue
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/)
    if (bullet) {
      list = list || []
      list.push(`<li>${inline(bullet[1])}</li>`)
      continue
    }
    closeList()
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      const level = heading[1].length
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
      continue
    }
    if (line.startsWith('> ')) {
      out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`)
      continue
    }
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  closeCode()

  return createElement('div', {
    className: 'wb-streamdown',
    dangerouslySetInnerHTML: { __html: out.join('') }
  })
}

export default { atom, useValue, host, icons, Tip, Streamdown, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA }
