/**
 * Screenshot the hosted board: open /board/, ask for a plan, wait for the
 * agent to lay it out, save a PNG. Doubles as the board's smoke test.
 *
 *   node scripts/shot.mjs [outfile] [prompt]
 */
import { chromium } from 'playwright'

const out = process.argv[2] || 'board.png'
const prompt = process.argv[3] || 'Launch a coffee subscription in four weeks'
const base = process.env.CANVAS_URL || 'http://127.0.0.1:8790/board/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, deviceScaleFactor: 1.5 })

const errors = []
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
page.on('pageerror', (e) => errors.push(String(e)))

await page.goto(base, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })

const before = await page.evaluate(() => document.body.innerText.length)
await page.fill('textarea', prompt)
await page.getByRole('button', { name: /lay it out/i }).click()

// The board is laid out when notes carry their per-note agent button.
await page.waitForFunction(() => document.body.innerText.includes('Hand to Hermes'), null, { timeout: 230000 })
// Let the layout settle, then frame the whole route.
await page
  .waitForFunction(() => !document.body.innerText.includes('is laying out'), null, { timeout: 60000 })
  .catch(() => {})
await page.getByRole('button', { name: /fit the board/i }).click().catch(() => {})
await page.waitForTimeout(3500) // let the last stamp land before the shot

const after = await page.evaluate(() => document.body.innerText.length)
const sections = await page.evaluate(
  () => [...document.querySelectorAll('*')].filter((n) => /^Week|^Day/.test(n.textContent || '') && n.children.length === 0).length
)

await page.screenshot({ path: out })
console.log(JSON.stringify({ out, prompt, textBefore: before, textAfter: after, sectionLabels: sections, errors }, null, 1))
await browser.close()
