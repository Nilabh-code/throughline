/**
 * Session-per-board acceptance: does a board's work continue in ONE agent
 * conversation, and does a new board get its own?
 *
 * Runs a real layout on a fresh board, then asks the bridge which sessions it
 * holds. Two different boards must appear as two entries; a second command on
 * the same board must reuse the first entry.
 *
 *   node scripts/session-check.mjs [url]
 */
import { chromium } from 'playwright'
import { writeFileSync } from 'node:fs'

// A test that dies without a verdict is worthless. Under a redirected/background
// stdio this suite can be reaped mid-run; leave a verdict behind either way.
const crashGuard = (error) => {
  try {
    writeFileSync(
      new URL('./session-check.json', import.meta.url),
      JSON.stringify({ crashed: String(error && error.stack || error) }, null, 2)
    )
  } catch {}
  console.error('CRASH:', error)
  process.exit(1)
}
process.on('uncaughtException', crashGuard)
process.on('unhandledRejection', crashGuard)


const url = process.argv[2] || 'http://127.0.0.1:8790/board/'
const bridge = new URL(url).origin

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })

const layOut = async (prompt) => {
  await page.waitForSelector('textarea', { timeout: 20000 })
  const field = page.getByPlaceholder(/Tell Hermes what you are planning/i).first()
  await field.fill(prompt)
  await page.getByRole('button', { name: /lay it out/i }).click()
  await page.waitForFunction(() => document.body.innerText.includes('Hand to Hermes'), null, { timeout: 230000 })
  await page.waitForTimeout(1500)
}

const boardId = () => page.evaluate(() => JSON.parse(localStorage.getItem('throughline:boards-v1') || '{}').activeId || null)

await page.goto(url, { waitUntil: 'domcontentloaded' })
// Start from a clean board so the run is deterministic.
await page.evaluate(() => localStorage.clear())
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

const health = async () => (await fetch(`${bridge}/health`)).json()
const sessionFor = (snapshot, key) => snapshot.boards.find((b) => b.key === key)?.session || null

// Board 1 — two commands, which must share one conversation.
const first = await boardId()
const key1 = `${first}:hermes`
await layOut('Plan a two week motorcycle trip to Ladakh')
const session1 = sessionFor(await health(), key1)
await layOut('Add the return leg through Manali')
const session2 = sessionFor(await health(), key1)

// Board 2 — switch boards the way the page does: a complete index entry AND its
// board record. (A half-written index is discarded by hydrate(), which then
// mints a brand-new id — which is why this test used to fail while the feature worked.)
const second = await page.evaluate(() => {
  const id = `board_${Math.random().toString(36).slice(2, 10)}`
  const index = JSON.parse(localStorage.getItem('throughline:boards-v1') || '{"boards":[]}')
  const now = Date.now()
  const board = {
    createdAt: now,
    id,
    items: [],
    layout: null,
    links: [],
    name: 'Second board',
    proposals: [],
    receipts: [],
    updatedAt: now,
    view: { x: 0, y: 0, zoom: 1 }
  }
  localStorage.setItem(`throughline:board:${id}`, JSON.stringify(board))
  localStorage.setItem(
    'throughline:boards-v1',
    JSON.stringify({ activeId: id, boards: [...(index.boards || []), { id, name: 'Second board' }] })
  )
  return id
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)
await layOut('Plan a team offsite')
const snap3 = await health()
const key2 = `${second}:hermes`

const checks = [
  { name: 'board 1 opened a session', ok: Boolean(session1), detail: `${key1} -> ${session1}` },
  {
    name: 'second command on board 1 reused that session',
    ok: Boolean(session1) && session1 === session2,
    detail: `${session1} vs ${session2}`
  },
  {
    name: 'second board got a different session',
    ok: Boolean(sessionFor(snap3, key2)) && sessionFor(snap3, key2) !== session1,
    detail: `${key2} -> ${sessionFor(snap3, key2)} (board 1: ${session1})`
  },
  {
    name: 'board 1 kept its session after the switch',
    ok: sessionFor(snap3, key1) === session1,
    detail: `${sessionFor(snap3, key1)}`
  },
  {
    name: 'every board key maps to a distinct session',
    ok: new Set(snap3.boards.map((b) => b.session)).size === snap3.boards.length,
    detail: snap3.boards.map((b) => `${b.key}=${b.session.slice(0, 8)}`).join(' ')
  }
]

const failed = checks.filter((c) => !c.ok)
const verdict = { url, first, second, checks, failed: failed.length }
// Written to disk as well as stdout: under a redirected Chromium run the
// console output can be swallowed, and a verdict nobody can read is not a test.
writeFileSync(new URL('./session-check.json', import.meta.url), JSON.stringify(verdict, null, 2))
console.log(JSON.stringify(verdict, null, 1))
await browser.close()
process.exit(failed.length ? 1 : 0)
