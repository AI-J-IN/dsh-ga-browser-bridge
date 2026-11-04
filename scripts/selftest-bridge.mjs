// Self-test the ExtensionBridge without a real Chrome extension: start the
// server, connect a stand-in client that speaks the protocol, and exercise
// every bridge method end-to-end over a real localhost WebSocket.
import WebSocket from 'ws'
import {
  EXTENSION_DEFAULT_PORT,
  EXTENSION_PROTOCOL_VERSION,
} from '../lib/extension/protocol.js'
import { ExtensionBridge } from '../lib/extension/bridge.js'

const PORT = 18899 // dedicated test port, away from the default

const log = (...a) => console.log('[selftest]', ...a)
let failures = 0
function check(name, cond, extra) {
  if (cond) log('PASS', name)
  else { failures++; log('FAIL', name, extra === undefined ? '' : JSON.stringify(extra)) }
}

const bridge = new ExtensionBridge({ port: PORT, requestTimeoutMs: 2000 })
await bridge.start()
log('bridge listening on', PORT)
check('not connected before any client', bridge.isConnected() === false)

// ---- stand-in extension client ----
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`)
const requests = []
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
log('stand-in client connected')

ws.on('message', (raw) => {
  let msg
  try { msg = JSON.parse(raw.toString()) } catch { return }
  if (typeof msg.id !== 'number') return
  requests.push(msg)
  const reply = (result) => ws.send(JSON.stringify({ id: msg.id, ok: true, result }))
  switch (msg.method) {
    case 'ping':
      return reply({ pong: true, protocolVersion: EXTENSION_PROTOCOL_VERSION })
    case 'tabs.list':
      return reply([
        { id: 11, title: 'GitHub', url: 'https://github.com/x', active: true, windowId: 1 },
        { id: 22, title: 'Example', url: 'https://example.com/', active: false, windowId: 1 },
      ])
    case 'page.evaluate':
      return reply({ value: 42 })
    case 'page.snapshot':
      return reply({ content: '<html>fake</html>', truncated: false, title: 'T', url: 'https://example.com/' })
    case 'cdp.send':
      // A real extension replies with the RAW CDP result, not a nested envelope.
      return reply({ protocolVersion: '1.3' })
    case 'cookies.get':
      return reply([{ name: 'sessionid', value: 'v', domain: '.github.com', httpOnly: true }])
    case 'tabs.activate':
    case 'tabs.close':
    case 'tabs.create':
      return reply({ id: 33, title: 'New', url: msg.params?.url ?? 'about:blank', active: true, windowId: 1 })
    default:
      return ws.send(JSON.stringify({ id: msg.id, ok: false, error: { code: 'UNKNOWN_METHOD', message: msg.method } }))
  }
})

// hello handshake
ws.send(JSON.stringify({
  method: 'hello',
  protocolVersion: EXTENSION_PROTOCOL_VERSION,
  extensionVersion: '0.1.0',
  browser: 'stand-in',
}))
await new Promise((r) => setTimeout(r, 300))
check('connected after hello', bridge.isConnected() === true)
check('connectionCount is 1', bridge.connectionCount() === 1)

// ---- exercise every wrapper ----
try {
  const tabs = await bridge.listTabs()
  check('listTabs returns 2 tabs', Array.isArray(tabs) && tabs.length === 2, tabs)
  check('tab ids are numeric', tabs[0]?.id === 11, tabs[0])
} catch (e) { check('listTabs', false, e.message) }

try {
  const v = await bridge.evaluate({ tabId: 11, expression: '6*7' })
  check('evaluate unwraps value 42', v === 42, v)
} catch (e) { check('evaluate', false, e.message) }

try {
  const s = await bridge.snapshot({ tabId: 11, maxchars: 100 })
  check('snapshot returns content', s.content === '<html>fake</html>', s)
  check('snapshot fills title/url', s.title === 'T' && s.url === 'https://example.com/', s)
} catch (e) { check('snapshot', false, e.message) }

try {
  const r = await bridge.sendCdp({ tabId: 11, method: 'Browser.getVersion' })
  check('sendCdp returns raw result', r && r.protocolVersion === '1.3', r)
} catch (e) { check('sendCdp', false, e.message) }

try {
  const c = await bridge.getCookies({ url: 'https://github.com' })
  check('getCookies returns array', Array.isArray(c) && c.length === 1, c)
} catch (e) { check('getCookies', false, e.message) }

// ---- concurrency: two in-flight requests must not cross wires ----
try {
  const [a, b] = await Promise.all([
    bridge.listTabs(),
    bridge.evaluate({ tabId: 11, expression: '1+1' }),
  ])
  check('concurrent requests both resolve correctly', a.length === 2 && b === 42, { a: a.length, b })
} catch (e) { check('concurrency', false, e.message) }

// ---- timeout path ----
const silentBridge = new ExtensionBridge({ port: PORT + 1, requestTimeoutMs: 150 })
await silentBridge.start()
const silent = new WebSocket(`ws://127.0.0.1:${PORT + 1}`)
await new Promise((r) => silent.once('open', r))
silent.send(JSON.stringify({ method: 'hello', protocolVersion: 1, extensionVersion: 'x', browser: 'y' }))
await new Promise((r) => setTimeout(r, 150))
try {
  await silentBridge.listTabs() // client never answers
  check('timeout rejects', false, 'resolved unexpectedly')
} catch (e) {
  check('timeout rejects with TIMEOUT', e.code === 'TIMEOUT', e.code)
}
silent.close()
await silentBridge.stop()

// ---- disconnect path ----
const dBridge = new ExtensionBridge({ port: PORT + 2, requestTimeoutMs: 5000 })
await dBridge.start()
const dWs = new WebSocket(`ws://127.0.0.1:${PORT + 2}`)
await new Promise((r) => dWs.once('open', r))
dWs.send(JSON.stringify({ method: 'hello', protocolVersion: 1, extensionVersion: 'x', browser: 'y' }))
await new Promise((r) => setTimeout(r, 150))
const pending = dBridge.listTabs().then(() => 'resolved').catch((e) => e.code)
dWs.close() // drop while in flight
const disconnectResult = await pending
check('in-flight request rejected on disconnect', disconnectResult === 'DISCONNECTED', disconnectResult)
check('isConnected false after drop', dBridge.isConnected() === false)
await dBridge.stop()

ws.close()
await bridge.stop()

log('---')
log('requests seen by stand-in:', requests.length, '| methods:', [...new Set(requests.map(r => r.method))].join(', '))
if (failures === 0) {
  log('ALL BRIDGE CHECKS PASSED')
  process.exit(0)
} else {
  log(`${failures} CHECK(S) FAILED`)
  process.exit(1)
}
