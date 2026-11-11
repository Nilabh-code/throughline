/**
 * Interaction repro: does the board survive being used?
 *
 * Walks the real input paths — hover, pan, zoom, add note, select, toolbar,
 * keyboard — and after EVERY step records whether the app is still alive plus
 * any page error / console error with its location.
 *
 *   node scripts/interact.mjs [url]
 */
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:8790/board/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('pageerror', (e) => errors.push({ kind: 'pageerror', message: String(e), stack: (e.stack || '').split('\n').slice(0, 6).join('\n') }))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push({ kind: 'console', message: m.text(), at: JSON.stringify(m.location()) })
})

const alive = () =>
  page.evaluate(() => {
    const root = document.getElementById('root')
    return {
      text: (root?.innerText || '').length,
      nodes: root?.querySelectorAll('*').length || 0,
      title: document.title
    }
  })

const steps = []
const record = async (name) => {
  const state = await alive()
  steps.push({ step: name, ...state, errors: errors.length })
  return state
}

await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })
await page.waitForTimeout(1200)
await record('loaded')

const canvas = await page.evaluate(() => {
  const t = document.querySelector('textarea')
  const r = (t?.closest('div') || document.body).getBoundingClientRect()
  return { w: window.innerWidth, h: window.innerHeight }
})

// 1. hover across the middle of the board
for (const x of [400, 700, 1000]) {
  await page.mouse.move(x, canvas.h / 2)
  await page.waitForTimeout(150)
}
await record('hover')

// 2. wheel zoom in and out over the canvas
await page.mouse.move(canvas.w / 2, canvas.h / 2)
await page.mouse.wheel(0, -240)
await page.waitForTimeout(300)
await record('wheel zoom in')
await page.mouse.wheel(0, 480)
await page.waitForTimeout(300)
await record('wheel zoom out')

// 3. drag to pan
await page.mouse.move(canvas.w / 2, canvas.h / 2)
await page.mouse.down()
await page.mouse.move(canvas.w / 2 - 220, canvas.h / 2 - 120, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(300)
await record('pan drag')

// 4. double-click the empty board to add a note
await page.mouse.dblclick(canvas.w * 0.6, canvas.h * 0.55)
await page.waitForTimeout(600)
const afterDbl = await record('double-click note')

// if a note editor opened, type into it and commit with Enter
const editor = page.locator('textarea:not(:first-of-type), [contenteditable="true"]').first()
if (await editor.count()) {
  await editor.fill?.('Ship the thing').catch(async () => editor.type('Ship the thing'))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(400)
}
await record('note typed')

// 5. keyboard: N new note, P pen, L select, Escape
for (const key of ['n', 'p', 'l', 'Escape']) {
  await page.keyboard.press(key)
  await page.waitForTimeout(250)
  await record(`key ${key}`)
}

// 6. toolbar buttons by accessible name
const buttons = ['Zoom in', 'Zoom out', 'Fit the board', 'Suggestions', 'Any shape', 'Route', 'Columns', 'Map']
for (const name of buttons) {
  const target = page.getByRole('button', { name, exact: false }).first()
  if (await target.count()) {
    await target.click({ timeout: 3000 }).catch(() => {})
    await page.waitForTimeout(220)
    await record(`click ${name}`)
  }
}

// 7. reload: does the board come back from storage?
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })
await page.waitForTimeout(1000)
await record('after reload')

const dead = steps.filter((s) => s.text < 50 || s.nodes < 5)
console.log(JSON.stringify({ url, steps, dead, errors: errors.slice(0, 8) }, null, 1))
await browser.close()
process.exit(dead.length ? 1 : 0)
