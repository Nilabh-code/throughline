/**
 * Journey test: use the board the way a person does, and assert each outcome.
 *
 * create → select → delete → persist across reload, plus pan/zoom/draw.
 * Any React crash empties #root, so every step also asserts the tree is alive.
 *
 *   node scripts/journey.mjs [url]
 */
import { chromium } from 'playwright'

const url = process.argv[2] || 'http://127.0.0.1:8790/board/'
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const errors = []
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text().slice(0, 200))
  if (m.type() === 'warning' && /plugin-sdk/.test(m.text())) errors.push(m.text())
})

const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: Boolean(ok), detail })
  if (!ok) console.log(`FAIL ${name} ${detail}`)
}

const alive = () => page.evaluate(() => (document.getElementById('root')?.querySelectorAll('*').length || 0) > 20)
const noteText = () =>
  page.evaluate(() => [...document.querySelectorAll('.wb-note')].map((n) => (n.innerText || '').trim()).join(' | '))

// 1 — empty board loads
await page.goto(url, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })
await page.waitForTimeout(1000)
check('board loads', await alive())

// 2 — double-click creates a note and the note takes text
await page.mouse.dblclick(720, 430)
await page.waitForTimeout(400)
const editor = page.locator('textarea').first()
await editor.fill('Ship the thing')
await page.keyboard.press('Enter')
await page.waitForTimeout(500)
const created = await noteText()
check('note created with text', created.includes('Ship the thing'), JSON.stringify(created))
check('alive after create', await alive())

// 3 — selecting the note renders the selection toolbar (the icons.Trash2 path)
const note = page.locator('.wb-note').first()
await note.click()
await page.waitForTimeout(400)
const hasDelete = await page.evaluate(
  () => [...document.querySelectorAll('.wb-tools [title]')].filter((el) => /delete/i.test(el.getAttribute('title') || '')).length
)
check('selection toolbar renders (delete button)', hasDelete > 0, `delete buttons: ${hasDelete}`)
check('alive after select', await alive())

// 4 — scroll zooms (the shell rewrites a plain wheel into the page's zoom gesture)
const zoom = () =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('*')].find(
      (n) => n.children.length === 0 && /^\d+%$/.test((n.textContent || '').trim())
    )
    return el ? Number(el.textContent.trim().replace('%', '')) : null
  })

const zoomBefore = await zoom()
await page.mouse.move(720, 430)
await page.mouse.wheel(0, -320)
await page.waitForTimeout(350)
const zoomedIn = await zoom()
check('wheel zooms in', zoomedIn !== null && zoomBefore !== null && zoomedIn > zoomBefore, `${zoomBefore}% -> ${zoomedIn}%`)

await page.mouse.wheel(0, 320)
await page.waitForTimeout(350)
const zoomedOut = await zoom()
check('wheel zooms out', zoomedOut !== null && zoomedIn !== null && zoomedOut < zoomedIn, `${zoomedIn}% -> ${zoomedOut}%`)
check('alive after wheel zoom', await alive())

// 5 — survives a reload (localStorage board)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })
await page.waitForTimeout(900)
const reloaded = await noteText()
check('note persists across reload', reloaded.includes('Ship the thing'), JSON.stringify(reloaded))
check('alive after reload', await alive())

// 5 — pan, zoom and draw without dying
await page.mouse.move(700, 450)
await page.mouse.wheel(0, -300)
await page.waitForTimeout(250)
await page.mouse.down()
await page.mouse.move(500, 350, { steps: 10 })
await page.mouse.up()
await page.keyboard.press('p')
await page.mouse.move(600, 500)
await page.mouse.down()
await page.mouse.move(760, 560, { steps: 8 })
await page.mouse.up()
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
check('alive after pan/zoom/draw', await alive())

// 6 — delete removes it, and the removal persists
await page.locator('.wb-note').first().click({ timeout: 5000 }).catch(() => {})
await page.waitForTimeout(300)
await page.keyboard.press('Backspace')
await page.waitForTimeout(400)
const afterDelete = await noteText()
check('note deleted', !afterDelete.includes('Ship the thing'), JSON.stringify(afterDelete))
check('alive after delete', await alive())

await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })
await page.waitForTimeout(800)
const afterReloadDelete = await noteText()
check('deletion persists', !afterReloadDelete.includes('Ship the thing'), JSON.stringify(afterReloadDelete))

const failed = checks.filter((c) => !c.ok)
console.log(JSON.stringify({ url, passed: checks.length - failed.length, failed: failed.length, checks, errors }, null, 1))
await browser.close()
process.exit(failed.length || errors.length ? 1 : 0)
