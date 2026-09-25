/**
 * Drive (and optionally record) a scripted interaction against a DSH web page.
 *
 *   node record.mjs <steps.json> [frames-dir] [--interval 320] [--no-frames]
 *
 * The page target is read from http://127.0.0.1:$CDP_PORT/json/list.
 *
 * Steps are a JSON array, run in order:
 *   { "eval": "<expression>" }   evaluate (awaits promises, prints the value)
 *   { "click": "<selector>" }    dispatch a full pointer sequence on the node
 *   { "key": "Escape", "mods": ["meta"] }
 *   { "wait": 900 }              milliseconds
 *   { "shot": "path.png" }       save one still
 *   { "label": "text" }          narration, printed and ignored otherwise
 *
 * Frames are captured on a timer for the whole run, so the recording shows the
 * interaction as a viewer would see it rather than one frame per step.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = process.env.CDP_PORT ?? '9222'
const [stepsPath, framesDir] = process.argv.slice(2)
const intervalIndex = process.argv.indexOf('--interval')
const INTERVAL = intervalIndex === -1 ? 320 : Number(process.argv[intervalIndex + 1])

const noFrames = process.argv.includes('--no-frames')
const steps = JSON.parse(readFileSync(stepsPath, 'utf8'))
if (!noFrames && framesDir !== undefined) mkdirSync(framesDir, { recursive: true })

async function target() {
  const response = await fetch(`http://127.0.0.1:${PORT}/json/list`)
  const targets = await response.json()
  const page = targets.find(candidate => candidate.type === 'page')
  if (page === undefined) throw new Error('no page target')
  return page.webSocketDebuggerUrl
}

async function connectWithRetry() {
  let last
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      const socket = new WebSocket(await target())
      await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, { once: true })
        socket.addEventListener('error', reject, { once: true })
      })
      return socket
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 1500))
    }
  }
  throw last
}

const socket = await connectWithRetry()
let id = 0
const pending = new Map()
socket.addEventListener('message', (event) => {
  const message = JSON.parse(String(event.data))
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
    else resolve(message.result)
  }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  id += 1
  pending.set(id, { resolve, reject })
  socket.send(JSON.stringify({ id, method, params }))
})

await send('Runtime.enable')
await send('Page.enable')

/** Capture frames until `stop` is set. */
let stop = false
let frame = 0
const capture = (async () => {
  while (!stop && !noFrames && framesDir !== undefined) {
    const started = Date.now()
    try {
      const shot = await send('Page.captureScreenshot', { format: 'png' })
      const name = `frame-${String(frame).padStart(5, '0')}.png`
      writeFileSync(join(framesDir, name), Buffer.from(shot.data, 'base64'))
      frame += 1
    } catch {
      // A navigation mid-capture is not fatal; the next tick retries.
    }
    const spent = Date.now() - started
    await new Promise(resolve => setTimeout(resolve, Math.max(0, INTERVAL - spent)))
  }
})()

const KEY_CODES = {
  Escape: { code: 'Escape', keyCode: 27, text: '' },
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  ArrowDown: { code: 'ArrowDown', keyCode: 40, text: '' },
  ArrowUp: { code: 'ArrowUp', keyCode: 38, text: '' },
}

for (const step of steps) {
  if (step.label !== undefined) console.log(`-- ${step.label}`)
  if (step.wait !== undefined) {
    await new Promise(resolve => setTimeout(resolve, step.wait))
    continue
  }
  if (step.eval !== undefined) {
    const result = await send('Runtime.evaluate', {
      expression: step.eval, awaitPromise: true, returnByValue: true,
    })
    const value = result.exceptionDetails !== undefined
      ? `EXCEPTION ${result.exceptionDetails.exception?.description ?? ''}`
      : JSON.stringify(result.result.value)
    console.log(`   eval -> ${String(value).slice(0, 160)}`)
    continue
  }
  if (step.shot !== undefined) {
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(step.shot, Buffer.from(shot.data, 'base64'))
    console.log(`   shot -> ${step.shot}`)
    continue
  }
  if (step.click !== undefined) {
    const result = await send('Runtime.evaluate', {
      expression: `(() => {
        const node = document.querySelector(${JSON.stringify(step.click)});
        if (!node) return 'NOT FOUND';
        node.scrollIntoView({ block: 'center' });
        const rect = node.getBoundingClientRect();
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          node.dispatchEvent(new MouseEvent(type, {
            bubbles: true, cancelable: true, view: window,
            clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2,
          }));
        }
        return 'clicked';
      })()`,
      awaitPromise: true, returnByValue: true,
    })
    console.log(`   click ${step.click} -> ${result.result.value}`)
    continue
  }
  if (step.key !== undefined) {
    const mods = step.mods ?? []
    const bits = (mods.includes('alt') ? 1 : 0) | (mods.includes('ctrl') ? 2 : 0)
      | (mods.includes('meta') ? 4 : 0) | (mods.includes('shift') ? 8 : 0)
    const descriptor = KEY_CODES[step.key] ?? { code: step.key, keyCode: 0, text: step.key }
    const base = {
      modifiers: bits, key: step.key, code: descriptor.code,
      windowsVirtualKeyCode: descriptor.keyCode, nativeVirtualKeyCode: descriptor.keyCode,
    }
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '' })
    if (descriptor.text !== '' && mods.length === 0) {
      await send('Input.dispatchKeyEvent', { type: 'char', ...base, text: descriptor.text })
    }
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
    console.log(`   key ${step.key}`)
    continue
  }
}

stop = true
await capture
socket.close()
console.log(noFrames ? 'done' : `captured ${frame} frames into ${framesDir}`)
