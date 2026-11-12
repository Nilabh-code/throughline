// Measures the two UI defects the reviewer flagged, after the fix.
import { chromium } from 'playwright'

const luminance = (rgb) => {
  const [r, g, b] = rgb.map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
const parse = (value) => (value.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
const ratio = (fg, bg) => {
  const [a, b] = [luminance(parse(fg)), luminance(parse(bg))].sort((x, y) => y - x)
  return Number(((a + 0.05) / (b + 0.05)).toFixed(2))
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1.5 })
const errors = []
page.on('pageerror', (e) => errors.push(String(e).split('\n')[0]))
await page.goto('http://127.0.0.1:8791/board/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('textarea', { timeout: 20000 })

// Contrast of the onboarding copy against whatever paper sits behind it.
const contrast = await page.evaluate(() => {
  const ink = (el) => {
    if (!el) return null
    let node = el
    let bg = 'rgba(0, 0, 0, 0)'
    while (node) {
      const value = getComputedStyle(node).backgroundColor
      const parts = value.match(/[\d.]+/g) || []
      const alpha = parts.length > 3 ? Number(parts[3]) : 1
      if (parts.length >= 3 && alpha > 0.1) {
        bg = value
        break
      }
      node = node.parentElement
    }
    return { text: (el.textContent || '').trim().slice(0, 40), color: getComputedStyle(el).color, bg }
  }
  const h1 = [...document.querySelectorAll('h1')].find((el) => /think it through/i.test(el.textContent || ''))
  const para = h1?.parentElement?.querySelector('p') || h1?.nextElementSibling
  return { heading: ink(h1), paragraph: ink(para) }
})

// Phone layout: one column, and nothing scrolled off to the side.
const phone = await browser.newPage({ viewport: { width: 375, height: 812 } })
await phone.goto('http://127.0.0.1:8791/board/', { waitUntil: 'domcontentloaded' })
// At phone width the module hides its composer, so wait on the rail instead.
await phone.waitForSelector('button[title="Bots"]', { timeout: 20000 })
await phone.click('button[title="Bots"]')
await phone.waitForSelector('text=Your bots', { timeout: 10000 })
const phoneLayout = await phone.evaluate(() => {
  const grid = document.querySelector('.bots-grid')
  const scroller = document.querySelector('.bots')
  const run = document.querySelector('.bot-run')
  return {
    columns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    scrollsSideways: scroller ? scroller.scrollWidth > scroller.clientWidth + 1 : null,
    runPanelVisible: run ? run.getBoundingClientRect().right <= window.innerWidth : null
  }
})
await phone.screenshot({ path: 'C:/Users/nilab/throughline/docs/bots-phone.png' })

// Long unbroken output must wrap inside its column.
const wrap = await page.evaluate(() => {
  const column = document.querySelector('.bot-column')
  if (!column) return 'no column'
  const style = getComputedStyle(column)
  return { columnMinWidth: style.minWidth, overflowWrap: style.overflowWrap }
})

await page.screenshot({ path: 'C:/Users/nilab/throughline/docs/board.png' })
await browser.close()

console.log(
  JSON.stringify(
    {
      contrast: {
        heading: { ...contrast.heading, ratio: ratio(contrast.heading.color, contrast.heading.bg) },
        paragraph: { ...contrast.paragraph, ratio: ratio(contrast.paragraph.color, contrast.paragraph.bg) }
      },
      phoneLayout,
      wrap,
      errors
    },
    null,
    1
  )
)
