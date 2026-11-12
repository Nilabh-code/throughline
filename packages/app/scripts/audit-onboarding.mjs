// Contrast of the onboarding copy against the paper canvas, found by text.
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://127.0.0.1:8791/board/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.wb-canvas', { timeout: 20000 })
await page.waitForTimeout(1500)

const report = await page.evaluate(() => {
  const parse = (v) => (v.match(/[\d.]+/g) || []).map(Number)
  const lum = (rgb) => {
    const [r, g, b] = rgb.slice(0, 3).map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  const ratio = (fg, bg) => {
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
    return Number(((a + 0.05) / (b + 0.05)).toFixed(2))
  }
  const paper = parse(getComputedStyle(document.querySelector('.wb-canvas')).backgroundColor)
  const find = (needle) =>
    [...document.querySelectorAll('h1,h2,p,span,div')].find(
      (el) => el.textContent && el.textContent.trim().startsWith(needle) && el.children.length === 0
    )
  const pick = (needle) => {
    const el = find(needle)
    if (!el) return { needle, missing: true }
    const style = getComputedStyle(el)
    return {
      needle,
      cls: el.className,
      color: style.color,
      size: style.fontSize,
      ratioOnPaper: ratio(parse(style.color), paper)
    }
  }
  return {
    paper: `rgb(${paper.slice(0, 3).join(', ')})`,
    probes: [
      pick('Think it through'),
      pick('Tell Hermes what you are planning'),
      pick('Or double-click anywhere'),
      pick('Enter to lay it out')
    ]
  }
})

await browser.close()
console.log(JSON.stringify(report, null, 1))
