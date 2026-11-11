/**
 * Scroll-to-zoom for the board.
 *
 * The plugin page pan on wheel and zooms only when Ctrl/Cmd is held
 * (desktop/plugin.js: `if (event.ctrlKey || event.metaKey) zoomAt(...) else pan`).
 * Its listener sits on the canvas node in the bubble phase, so a capture-phase
 * listener here can rewrite a plain wheel into the modifier gesture it already
 * understands — same code path, no page edit.
 *
 *   plain wheel        zoom in / out around the pointer
 *   shift + wheel      pan (falls through to the page untouched)
 *   ctrl/meta + wheel  zoom (pinch on a trackpad lands here natively)
 */

const MARK = '__canvasZoomRewrite'

/**
 * The page's zoom step is tuned for trackpad pinch (deltaY of a few units):
 * `Math.exp(-deltaY * 0.0105)`. One Windows wheel notch is ~120 units, which
 * would be a 3.5x jump, so the rewrite feeds it a damped delta instead.
 */
const SENSITIVITY = 0.12
const deltaInPageUnits = (event) => {
  const perUnit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1 // line / page / pixel
  const damped = event.deltaY * perUnit * SENSITIVITY
  return Math.sign(damped) * Math.min(Math.abs(damped), 40)
}

const isFormField = (el) =>
  !!el?.closest?.('input, textarea, select, [contenteditable="true"], [data-nodrag]')

export function installScrollZoom(stage, { onZoom } = {}) {
  if (!stage) return () => {}

  const rewrite = (event) => {
    if (event[MARK]) return
    if (event.ctrlKey || event.metaKey || event.shiftKey) return
    if (!event.deltaY) return
    if (isFormField(event.target)) return
    if (!stage.contains(event.target)) return

    const clone = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: event.clientX,
      clientY: event.clientY,
      deltaX: event.deltaX * SENSITIVITY,
      deltaY: deltaInPageUnits(event),
      deltaZ: 0,
      deltaMode: 0,
      ctrlKey: true // what the page reads as "zoom this"
    })
    Object.defineProperty(clone, MARK, { value: true })

    event.preventDefault()
    event.stopPropagation()
    event.target.dispatchEvent(clone)
    onZoom?.({ direction: event.deltaY < 0 ? 'in' : 'out', at: { x: event.clientX, y: event.clientY } })
  }

  window.addEventListener('wheel', rewrite, { capture: true, passive: false })
  return () => window.removeEventListener('wheel', rewrite, { capture: true })
}
