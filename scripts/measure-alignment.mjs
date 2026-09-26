/**
 * Assert the new-session screen's alignment against a running DSH page.
 *
 *   CDP_PORT=9400 node measure-alignment.mjs
 *
 * Opens (or reuses) the blank-session hero, reads the geometry of the composer
 * card, its tool row, the headline stack and the branch strip, and fails with a
 * non-zero exit when any invariant below drifts.
 *
 * The invariants are the ones documented in README.md#alignment:
 *
 *   1. the strip's border box equals the composer tool row's CONTENT box, which
 *      is also the HeroShell stack's box (the axis the whole screen shares);
 *   2. the strip starts exactly one dock inset inside that box;
 *   3. the card, the strip and the headline share one horizontal centre;
 *   4. the strip's text sits 4px under the card;
 *   5. the reasoning-effort control is the same height as, and vertically
 *      centred with, the attach button and the permission control beside it.
 *
 * Only node: builtins are used, so it runs on the bundled runtime as-is.
 */
import { readFileSync } from 'node:fs'

const PORT = process.env.CDP_PORT ?? '9222'

/** Resolve the page target, retrying: the devtools HTTP endpoint hiccups. */
async function target() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const targets = await response.json()
      const page = targets.find(candidate => candidate.type === 'page')
      if (page !== undefined) return page.webSocketDebuggerUrl
    } catch {
      // fall through to the retry
    }
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  throw new Error(`no page target on 127.0.0.1:${PORT}`)
}

const socket = new WebSocket(await target())
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})

let id = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id === undefined || !pending.has(message.id)) return
  const { resolve, reject } = pending.get(message.id)
  pending.delete(message.id)
  if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
  else resolve(message.result)
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')

/** Evaluate an expression in the page and return its value. */
async function evaluate(expression) {
  const result = await send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true,
  })
  if (result.exceptionDetails !== undefined) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
  }
  return result.result.value
}

/**
 * The measurement probe, kept in one expression so the page is read atomically.
 *
 * Every anchor is derived structurally rather than by CSS-module class name: the
 * hashes change per build, so the tool row is found by walking up from this
 * plugin's own effort control to the nearest flex row wide enough to be the
 * card's tool row, and the neighbourhood is every other button inside it.
 */
const PROBE = `(() => {
  const rect = (el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x, right: r.right, y: r.y, bottom: r.bottom, w: r.width, h: r.height }
  }
  const strip = document.querySelector('.t3nss-strip')
  const chip = document.querySelector('.t3nss-chip')
  // The tool row: nearest flex ancestor of the effort control that is wide
  // enough to span the card (the inner leading group is only a few hundred px).
  let row = null
  for (let n = chip ? chip.parentElement : null; n !== null; n = n.parentElement) {
    const cs = getComputedStyle(n)
    if (cs.display === 'flex' && n.getBoundingClientRect().width > 600) { row = n; break }
  }
  const rowStyle = row ? getComputedStyle(row) : null

  // The card: nearest ancestor of the effort control carrying the composer's
  // radius. It is NOT an ancestor of the strip, which is a sibling branch.
  let cardEl = null
  for (let n = chip ? chip.parentElement : null; n !== null; n = n.parentElement) {
    if (getComputedStyle(n).borderRadius.startsWith('22px')) { cardEl = n; break }
  }

  const neighbours = row
    ? [...row.querySelectorAll('button')]
        .map(rect)
        .filter(r => r.w > 0 && r.h > 20)
    : []

  return {
    hero: !!document.querySelector('[class*="composerHero"]'),
    phase: strip ? strip.dataset.phase : null,
    card: cardEl ? rect(cardEl) : null,
    strip: strip ? rect(strip) : null,
    stripPadLeft: strip ? parseFloat(getComputedStyle(strip).paddingLeft) : null,
    rowContent: row
      ? { x: row.getBoundingClientRect().x + parseFloat(rowStyle.paddingLeft),
          right: row.getBoundingClientRect().right - parseFloat(rowStyle.paddingRight) }
      : null,
    headlineStack: (() => {
      // The HeroShell stack: the ancestor of the headline text that carries the
      // composer card cap as its max-width.
      const head = document.querySelector('.t3nss-headlineRoot')
      for (let n = head ? head.parentElement : null; n !== null; n = n.parentElement) {
        const mw = getComputedStyle(n).maxWidth
        if (mw !== 'none' && parseFloat(mw) > 400) return rect(n)
      }
      return null
    })(),
    chip: chip ? rect(chip) : null,
    // The two controls immediately beside the effort control: same row band, to
    // its left. The submit button is deliberately taller and is not a peer.
    leading: chip
      ? neighbours.filter(r => Math.abs(r.y - chip.getBoundingClientRect().y) <= 1
          && r.x < chip.getBoundingClientRect().x)
      : [],
    neighbours,
  }
})()`

// Give the page a moment to settle after a reload, then open a blank session.
await evaluate(`(() => {
  const dismiss = [...document.querySelectorAll('button')]
    .filter(b => /configure later|continue/i.test(b.textContent || ''))
  dismiss.forEach(b => b.click())
  return dismiss.length
})()`)
await new Promise(resolve => setTimeout(resolve, 1500))
const hasStrip = await evaluate(`!!document.querySelector('.t3nss-strip')`)
if (!hasStrip) {
  await evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /^New session$/i.test((x.textContent || '').trim()))
    if (b) b.click()
    return !!b
  })()`)
  await new Promise(resolve => setTimeout(resolve, 4000))
}

const m = await evaluate(PROBE)
socket.close()

/** One check result. */
const failures = []
const near = (a, b, tolerance = 1) => Math.abs(a - b) <= tolerance
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(label)
}

if (m.card === null || m.strip === null || m.rowContent === null || m.headlineStack === null) {
  console.error('FAIL  the composer card, tool row, headline stack or strip is not mounted')
  console.error(JSON.stringify(m, null, 2))
  process.exit(2)
}

console.log(`phase: ${m.phase}${m.hero ? ' (hero)' : ''}`)
console.log(`card          ${m.card.x}..${m.card.right}`)
console.log(`tool content  ${m.rowContent.x}..${m.rowContent.right}`)
console.log(`headline      ${m.headlineStack.x}..${m.headlineStack.right}`)
console.log(`strip         ${m.strip.x}..${m.strip.right}`)
console.log('')

check(
  '1. strip border box == tool row content box',
  near(m.strip.x, m.rowContent.x) && near(m.strip.right, m.rowContent.right),
  `${m.strip.x.toFixed(1)}..${m.strip.right.toFixed(1)} vs ${m.rowContent.x.toFixed(1)}..${m.rowContent.right.toFixed(1)}`,
)
check(
  '1b. strip border box == headline stack box',
  near(m.strip.x, m.headlineStack.x) && near(m.strip.right, m.headlineStack.right),
  `${m.headlineStack.x.toFixed(1)}..${m.headlineStack.right.toFixed(1)}`,
)
check(
  '2. strip content starts one dock inset inside that box',
  near(m.strip.x + m.stripPadLeft, m.rowContent.x + 8),
  `content ${(m.strip.x + m.stripPadLeft).toFixed(1)} vs ${(m.rowContent.x + 8).toFixed(1)}`,
)
check(
  '3. card, strip and headline share one centre',
  near((m.card.x + m.card.right) / 2, (m.strip.x + m.strip.right) / 2)
    && near((m.card.x + m.card.right) / 2, (m.headlineStack.x + m.headlineStack.right) / 2),
  `centre ${((m.card.x + m.card.right) / 2).toFixed(1)}`,
)
check(
  '4. strip text sits 4px under the card',
  near(m.strip.y - m.card.bottom, 4),
  `gap ${(m.strip.y - m.card.bottom).toFixed(1)}px`,
)

if (m.chip !== null && m.leading.length > 0) {
  const chipCentre = (m.chip.y + m.chip.bottom) / 2
  check(
    '5. effort control matches the controls beside it in height',
    m.leading.every(r => near(m.chip.h, r.h)),
    `chip ${m.chip.h} vs ${m.leading.map(r => r.h).join(', ')}`,
  )
  check(
    '5b. effort control is vertically centred with them',
    m.leading.every(r => near(chipCentre, (r.y + r.bottom) / 2)),
    `centre ${chipCentre.toFixed(1)} vs ${m.leading.map(r => ((r.y + r.bottom) / 2).toFixed(1)).join(', ')}`,
  )
} else {
  console.log('SKIP  5. effort control not mounted (the model advertises no effort levels)')
}

console.log('')
if (failures.length > 0) {
  console.error(`${failures.length} alignment check(s) failed`)
  process.exit(1)
}
console.log('all alignment checks passed')
