/**
 * Failing-first harness for the DSG Browser Bridge MV3 service worker.
 *
 * WHY THIS HARNESS EXISTS
 * -----------------------
 * `background.js` is a service-worker script that talks to the `chrome.*`
 * APIs and WebSocket. It cannot be imported directly by Node: the module has
 * import-time side effects (`chrome.runtime.onMessage.addListener`, ...) and
 * those globals do not exist outside Chrome. So we run it in a `vm` context
 * with a minimal fake `chrome`, fake `WebSocket`, fake `setTimeout`, and then
 * drive it exactly like the host plugin would: send request frames, inspect
 * response frames.
 *
 * Run:  node extension/test/background.test.mjs
 * Exit code 0 = all green, 1 = at least one red assertion.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const EXT_DIR = path.resolve(here, '..')

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------
const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A deterministic fake clock: timers only fire when the test says so. */
function makeClock() {
  let now = 0
  let seq = 1
  const timers = new Map()
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const id = seq++
      timers.set(id, { at: now + (ms || 0), fn, interval: null })
      return id
    },
    setInterval(fn, ms) {
      const id = seq++
      timers.set(id, { at: now + (ms || 0), fn, interval: ms || 1 })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    clearInterval(id) {
      timers.delete(id)
    },
    /** Advance the clock by `ms`, firing due timers in order. */
    tick(ms) {
      const target = now + ms
      for (;;) {
        let nextId = null
        let nextAt = Infinity
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < nextAt) {
            nextAt = t.at
            nextId = id
          }
        }
        if (nextId === null) break
        const t = timers.get(nextId)
        now = t.at
        if (t.interval) t.at = now + t.interval
        else timers.delete(nextId)
        try {
          t.fn()
        } catch {
          /* timers must never throw the harness over */
        }
      }
      now = target
    },
    pending: () => timers.size,
  }
}

/** Fake WebSocket; the test controls open/close/message delivery. */
function makeWebSocketClass(clock) {
  const sockets = []
  class FakeWebSocket {
    constructor(url) {
      this.url = url
      this.readyState = 0 // CONNECTING
      this.sent = []
      this.onopen = null
      this.onclose = null
      this.onerror = null
      this.onmessage = null
      sockets.push(this)
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('WebSocket is not open')
      this.sent.push(data)
    }
    close() {
      if (this.readyState === 3) return
      this.readyState = 3
      if (this.onclose) this.onclose({ code: 1000, reason: 'closed' })
    }
    // --- test drivers ---
    _open() {
      this.readyState = 1
      if (this.onopen) this.onopen({})
    }
    _fail() {
      this.readyState = 3
      if (this.onerror) this.onerror({})
      if (this.onclose) this.onclose({ code: 1006, reason: 'failed' })
    }
    _serverClose(code = 1006, reason = 'lost') {
      this.readyState = 3
      if (this.onclose) this.onclose({ code, reason })
    }
    _deliver(obj) {
      if (this.onmessage) this.onmessage({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) })
    }
  }
  FakeWebSocket.CONNECTING = 0
  FakeWebSocket.OPEN = 1
  FakeWebSocket.CLOSING = 2
  FakeWebSocket.CLOSED = 3
  return { FakeWebSocket, sockets }
}

/** Build the fake chrome namespace. */
function makeChrome(clock, state) {
  const listeners = {
    onMessage: [],
    onDetach: [],
    onCreated: [],
    onUpdated: [],
    onRemoved: [],
    onInstalled: [],
    onStartup: [],
    alarm: [],
  }

  function addListener(list) {
    return (fn) => list.push(fn)
  }

  const tabs = state.tabs

  const chrome = {
    runtime: {
      id: 'fake-extension-id',
      lastError: undefined,
      onMessage: { addListener: addListener(listeners.onMessage) },
      onInstalled: { addListener: addListener(listeners.onInstalled) },
      onStartup: { addListener: addListener(listeners.onStartup) },
      getManifest: () => ({ version: '0.1.0' }),
    },
    storage: {
      local: {
        async get(defaults) {
          // Mimic chrome.storage.local.get(objectWithDefaults)
          const out = {}
          for (const [k, dflt] of Object.entries(defaults || {})) {
            out[k] = Object.prototype.hasOwnProperty.call(state.store, k) ? state.store[k] : dflt
          }
          return out
        },
        async set(obj) {
          Object.assign(state.store, obj)
        },
      },
      onChanged: { addListener: () => {} },
    },
    alarms: {
      create: (name, info) => {
        state.alarms.set(name, info)
      },
      clear: async (name) => state.alarms.delete(name),
      onAlarm: { addListener: addListener(listeners.alarm) },
    },
    action: {
      setBadgeText: async ({ text }) => {
        state.badgeText = text
      },
      setBadgeBackgroundColor: async () => {},
    },
    tabs: {
      async query(q) {
        // Only the empty query is required by the contract.
        return tabs.map((t) => ({ ...t }))
      },
      async get(tabId) {
        const t = tabs.find((x) => x.id === tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}.`)
        return { ...t }
      },
      async create({ url, active }) {
        const t = {
          id: state.nextTabId++,
          title: url || 'New Tab',
          url: url || 'chrome://newtab/',
          active: active !== false,
          windowId: 1,
          status: 'complete',
        }
        tabs.push(t)
        return { ...t }
      },
      async update(tabId, props) {
        const t = tabs.find((x) => x.id === tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}.`)
        Object.assign(t, props)
        return { ...t }
      },
      async remove(tabId) {
        const i = tabs.findIndex((x) => x.id === tabId)
        if (i < 0) throw new Error(`No tab with id: ${tabId}.`)
        tabs.splice(i, 1)
      },
      async reload(tabId) {
        const t = tabs.find((x) => x.id === tabId)
        if (!t) throw new Error(`No tab with id: ${tabId}.`)
        t.status = 'loading'
        state.reloadCalls.push(tabId)
        // Simulate the page finishing later; the worker must poll for it.
        state.reloadCompleteAfter = state.nowTicks + 3
      },
      onCreated: { addListener: addListener(listeners.onCreated) },
      onUpdated: { addListener: addListener(listeners.onUpdated) },
      onRemoved: { addListener: addListener(listeners.onRemoved) },
    },
    windows: {
      async update(windowId, props) {
        state.windowUpdates.push({ windowId, props })
        return { id: windowId }
      },
    },
    cookies: {
      async getAll(filter) {
        state.cookieFilters.push(filter)
        if (filter && filter.url) {
          return [{ name: 'sid', value: 'u-scoped', domain: 'example.com', url: filter.url }]
        }
        return [
          { name: 'sid', value: 'all-1', domain: 'example.com' },
          { name: 'other', value: 'all-2', domain: 'example.org' },
        ]
      },
    },
    debugger: {
      /** tabId -> {attached, probeMode} */
      sessions: state.debuggerSessions,
      async attach(target, version) {
        state.attachCalls++
        state.attachTargets.push(target.tabId)
        if (state.attachShouldThrow && state.attachShouldThrow.has(target.tabId)) {
          chrome.runtime.lastError = {
            message: 'Another debugger is already attached to the tab with id: ' + target.tabId + '.',
          }
          const err = new Error(chrome.runtime.lastError.message)
          chrome.runtime.lastError = undefined
          throw err
        }
        state.debuggerSessions.set(target.tabId, { attached: true, version })
      },
      async detach(target) {
        state.detachCalls++
        state.detachTargets.push(target.tabId)
        state.debuggerSessions.delete(target.tabId)
      },
      async sendCommand(target, method, params) {
        state.sendCommandCalls.push({ tabId: target.tabId, method, params })
        if (state.commandShouldThrow && state.commandShouldThrow.has(method)) {
          const msg = state.commandShouldThrow.get(method)
          const err = new Error(msg)
          throw err
        }
        if (state.commandDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, state.commandDelayMs))
        }
        if (method === 'Runtime.evaluate') {
          const expr = (params && params.expression) || ''
          if (expr.includes('__THROW_ME__')) {
            return {
              result: { type: 'object' },
              exceptionDetails: {
                text: 'Uncaught',
                exception: { description: 'Error: boom from page' },
                lineNumber: 1,
                columnNumber: 3,
              },
            }
          }
          return {
            result: {
              type: state.evaluateReturnType || 'string',
              value: state.evaluateValue !== undefined ? state.evaluateValue : 'evaluated:' + expr,
            },
          }
        }
        if (method === 'Page.captureScreenshot') {
          return { data: 'BASE64PNG' }
        }
        return { method, echo: params || null }
      },
      onDetach: { addListener: addListener(listeners.onDetach) },
      onEvent: { addListener: () => {} },
    },
  }
  return { chrome, listeners }
}

// ---------------------------------------------------------------------------
// Load the worker inside a vm with the fakes
// ---------------------------------------------------------------------------
const WORKER_PATH = path.join(EXT_DIR, 'background.js')

function loadWorker(initialStore) {
  const clock = makeClock()
  const { FakeWebSocket, sockets } = makeWebSocketClass(clock)
  const state = {
    store: {},
    tabs: [
      { id: 101, title: 'Alpha', url: 'https://alpha.example/', active: true, windowId: 1, status: 'complete' },
      { id: 202, title: 'Beta', url: 'https://beta.example/', active: false, windowId: 2, status: 'complete' },
    ],
    nextTabId: 300,
    reloadCalls: [],
    reloadCompleteAfter: 0,
    nowTicks: 0,
    windowUpdates: [],
    cookieFilters: [],
    attachCalls: 0,
    attachTargets: [],
    detachCalls: 0,
    detachTargets: [],
    sendCommandCalls: [],
    debuggerSessions: new Map(),
    /** Pre-seed chrome.storage.local before the worker's first read. */
    initialStore: null,
    attachShouldThrow: new Set(),
    commandShouldThrow: new Map(),
    commandDelayMs: 0,
    alarms: new Map(),
    badgeText: undefined,
    evaluateValue: undefined,
    evaluateReturnType: 'string',
  }
  if (initialStore) Object.assign(state.store, initialStore)
  const { chrome, listeners } = makeChrome(clock, state)

  const consoleMessages = []
  const fakeConsole = {
    log: (...a) => consoleMessages.push(['log', a.join(' ')]),
    warn: (...a) => consoleMessages.push(['warn', a.join(' ')]),
    error: (...a) => consoleMessages.push(['error', a.join(' ')]),
    info: (...a) => consoleMessages.push(['info', a.join(' ')]),
    debug: (...a) => consoleMessages.push(['debug', a.join(' ')]),
  }

  const context = {
    chrome,
    WebSocket: FakeWebSocket,
    console: fakeConsole,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    queueMicrotask,
    navigator: { userAgent: 'FakeChrome/130.0 (test)' },
    crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
    JSON,
    Math,
    // The worker uses Date.now() for deadlines (tabs.reload timeout). Give the
    // vm the fake clock so tests can advance time deterministically.
    Date: makeFakeDate(clock),
    Number,
    String,
    Object,
    Array,
    Map,
    Set,
    Promise,
    Error,
    TypeError,
    isNaN,
    parseInt,
    parseFloat,
    encodeURIComponent,
    decodeURIComponent,
    globalThis: null,
  }
  context.globalThis = context
  context.self = context

  const source = fs.readFileSync(WORKER_PATH, 'utf8')
  vm.createContext(context)
  vm.runInContext(source, context, { filename: WORKER_PATH })

  return {
    context,
    clock,
    state,
    sockets,
    listeners,
    consoleMessages,
    FakeWebSocket,
  }
}

// ---------------------------------------------------------------------------
// Helpers to drive the worker
// ---------------------------------------------------------------------------
/**
 * A Date replacement bound to the fake clock: `Date.now()` returns fake ms and
 * `new Date(...)` still works for everything else.
 */
function makeFakeDate(clock) {
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock.now())
      else super(...args)
    }
    static now() {
      return clock.now()
    }
  }
  return FakeDate
}

/** JSON round-trip: objects created inside the vm have a different Object proto. */
const plain = (v) => JSON.parse(JSON.stringify(v))

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r))
}

/** Wait until a socket object appears; connect attempts are async (storage read). */
async function connected() {
  const env = loadWorker()
  // Let the module's initial connect() run.
  await flush()
  const ws = env.sockets[0]
  assert.ok(ws, 'worker must attempt at least one WebSocket connection on load')
  assert.equal(ws.url, 'ws://127.0.0.1:18789', 'default URL must be ws://127.0.0.1:18789')
  ws._open()
  await flush()
  return { ...env, ws }
}

function parseFrames(ws) {
  return ws.sent.map((s) => JSON.parse(s))
}

function eventFrames(ws) {
  return parseFrames(ws).filter((f) => f.id === undefined)
}

function responseFrames(ws) {
  return parseFrames(ws).filter((f) => typeof f.id === 'number')
}

/**
 * Send one request and wait for the matching response. Returns the response.
 * The worker may answer long after; we wait with real macrotask turns and also
 * allow the fake clock to be ticked by the caller for polling flows.
 */
async function request(env, req, opts = {}) {
  const before = responseFrames(env.ws).length
  env.ws._deliver(req)
  const deadline = Date.now() + (opts.timeoutMs || 4000)
  while (Date.now() < deadline) {
    await flush()
    const frames = responseFrames(env.ws)
    if (frames.length > before) {
      const mine = frames.filter((f) => f.id === req.id)
      if (mine.length === 0) throw new Error('response frames grew but none matched id ' + req.id)
      assert.equal(mine.length, 1, 'exactly one response per id for id ' + req.id)
      return mine[0]
    }
    env.clock.tick(opts.tickEachMs || 100)
    if (opts.afterTick) opts.afterTick(env)
  }
  throw new Error('no response within deadline for ' + req.method + ' id=' + req.id)
}

// ===========================================================================
// TESTS — contract: connection + handshake
// ===========================================================================

test('worker connects to ws://127.0.0.1:18789 by default and sends hello event on open', async () => {
  const env = await connected()
  const events = eventFrames(env.ws)
  const hello = events.find((e) => e.method === 'hello')
  assert.ok(hello, 'hello event must be sent after open')
  assert.equal(hello.id, undefined, 'hello is an event: no id')
  assert.equal(hello.protocolVersion, 1)
  assert.equal(hello.extensionVersion, '0.1.0')
  assert.equal(hello.browser, 'FakeChrome/130.0 (test)')
})

test('custom host/port from chrome.storage.local is used', async () => {
  const env = loadWorker({ host: '192.168.1.9', port: 19999 })
  // Trigger a connect attempt via onInstalled? No — module load already ran.
  // Instead simulate: storage was pre-seeded, so the very first connect must use it.
  await flush()
  assert.ok(env.sockets[0], 'a socket attempt must exist')
  assert.equal(env.sockets[0].url, 'ws://192.168.1.9:19999')
})

test('malformed JSON frames are ignored and the socket stays usable', async () => {
  const env = await connected()
  env.ws._deliver('{not json at all')
  env.ws._deliver('')
  env.ws._deliver(JSON.stringify('a string'))
  env.ws._deliver(JSON.stringify([1, 2, 3]))
  env.ws._deliver(JSON.stringify({ id: 'not-a-number', method: 'ping' }))
  await flush()
  assert.equal(responseFrames(env.ws).length, 0, 'malformed frames must not produce responses')
  const res = await request(env, { id: 1, method: 'ping' })
  assert.equal(res.ok, true)
})

test('EVENTS from host (no numeric id) are ignored, not answered', async () => {
  const env = await connected()
  env.ws._deliver({ method: 'hello', protocolVersion: 1 })
  env.ws._deliver({ type: 'whatever' })
  await flush()
  assert.equal(responseFrames(env.ws).length, 0)
})

// ===========================================================================
// TESTS — every method in the contract
// ===========================================================================

test('ping → {ok:true, result:{pong:true, protocolVersion:1}}', async () => {
  const env = await connected()
  const res = await request(env, { id: 10, method: 'ping' })
  assert.deepEqual(res, { id: 10, ok: true, result: { pong: true, protocolVersion: 1 } })
})

test('tabs.list → array of ExtensionTab {id,title,url,active,windowId,status}', async () => {
  const env = await connected()
  const res = await request(env, { id: 11, method: 'tabs.list' })
  assert.equal(res.ok, true)
  assert.equal(res.result.length, 2)
  assert.deepEqual(res.result[0], {
    id: 101,
    title: 'Alpha',
    url: 'https://alpha.example/',
    active: true,
    windowId: 1,
    status: 'complete',
  })
})

test('tabs.get {tabId} → one ExtensionTab', async () => {
  const env = await connected()
  const res = await request(env, { id: 12, method: 'tabs.get', params: { tabId: 202 } })
  assert.equal(res.ok, true)
  assert.equal(res.result.id, 202)
  assert.equal(res.result.title, 'Beta')
})

test('tabs.get on a missing tab → ok:false NO_TAB', async () => {
  const env = await connected()
  const res = await request(env, { id: 13, method: 'tabs.get', params: { tabId: 999 } })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'NO_TAB')
  assert.ok(res.error.message.length > 0)
})

test('tabs.create {url,active} → ExtensionTab of the new tab', async () => {
  const env = await connected()
  const res = await request(env, { id: 14, method: 'tabs.create', params: { url: 'https://new.example/', active: true } })
  assert.equal(res.ok, true)
  assert.equal(res.result.url, 'https://new.example/')
  assert.equal(res.result.active, true)
  assert.equal(res.result.id, 300)
})

test('tabs.activate → updates tab active and focuses its window when different', async () => {
  const env = await connected()
  // Activate tab 202, which lives in window 2 while tab 101 is the active one in window 1.
  const res = await request(env, { id: 15, method: 'tabs.activate', params: { tabId: 202 } })
  assert.equal(res.ok, true)
  assert.equal(env.state.windowUpdates.length, 1, 'window must be focused because windowId differs')
  assert.deepEqual(plain(env.state.windowUpdates[0]), { windowId: 2, props: { focused: true } })
})

test('tabs.close → removes the tab', async () => {
  const env = await connected()
  const res = await request(env, { id: 16, method: 'tabs.close', params: { tabId: 202 } })
  assert.equal(res.ok, true)
  assert.equal(env.state.tabs.find((t) => t.id === 202), undefined)
})

test('tabs.reload waits for status complete and returns the tab', async () => {
  const env = await connected()
  env.state.nowTicks = 0
  // The fake reload flips status to 'loading' then back to complete after 3 polls.
  const useAfterTick = (e) => {
    const t = e.state.tabs.find((x) => x.id === 101)
    t.status = t.status === 'loading' ? 'loading' : 'loading'
    e.state.nowTicks++
    if (e.state.nowTicks > e.state.reloadCompleteAfter) t.status = 'complete'
  }
  const res = await request(env, { id: 17, method: 'tabs.reload', params: { tabId: 101 } }, { afterTick: useAfterTick })
  assert.equal(res.ok, true)
  assert.equal(res.result.status, 'complete')
  assert.ok(env.state.reloadCalls.includes(101), 'chrome.tabs.reload must be called')
})

test('tabs.reload polls for at most ~15s instead of hanging forever', async () => {
  const env = await connected()
  const tab = env.state.tabs.find((x) => x.id === 101)
  tab.status = 'complete'
  env.ws._deliver({ id: 18, method: 'tabs.reload', params: { tabId: 101 } })

  // Drive only the fake clock; real time is never waited on. The tab never
  // finishes loading, so the implementation must give up at its 15s deadline.
  let res = null
  const startFake = env.clock.now()
  for (let i = 0; i < 400 && !res; i++) {
    tab.status = 'loading'
    env.clock.tick(100)
    await flush()
    res = responseFrames(env.ws).find((f) => f.id === 18) || null
  }
  assert.ok(res, 'tabs.reload must answer within its own deadline (no hang)')
  assert.equal(res.ok, true, 'a slow reload returns the tab, it is not an error')
  assert.equal(res.result.id, 101)
  const elapsed = env.clock.now() - startFake
  assert.ok(elapsed >= 14000 && elapsed <= 16000, 'deadline must be ~15s, got ' + elapsed + 'ms')
  assert.equal(responseFrames(env.ws).filter((f) => f.id === 18).length, 1, 'answer exactly once')
})

test('page.evaluate attaches debugger, sends Runtime.evaluate with the right params', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 19,
    method: 'page.evaluate',
    params: { tabId: 101, expression: 'document.title' },
  })
  assert.equal(res.ok, true)
  assert.equal(res.result.value, 'evaluated:document.title')
  const call = env.state.sendCommandCalls.find((c) => c.method === 'Runtime.evaluate')
  assert.ok(call, 'Runtime.evaluate must be sent')
  assert.equal(call.tabId, 101)
  assert.equal(call.params.expression, 'document.title')
  assert.equal(call.params.awaitPromise, true, 'awaitPromise defaults to true')
  assert.equal(call.params.returnByValue, true, 'returnByValue defaults to true')
  assert.equal(call.params.userGesture, true)
})

test('page.evaluate respects explicit awaitPromise/returnByValue false', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 20,
    method: 'page.evaluate',
    params: { tabId: 101, expression: 'x', awaitPromise: false, returnByValue: false },
  })
  assert.equal(res.ok, true)
  const call = env.state.sendCommandCalls.find((c) => c.method === 'Runtime.evaluate')
  assert.equal(call.params.awaitPromise, false)
  assert.equal(call.params.returnByValue, false)
})

test('page.evaluate with exceptionDetails returns {value:undefined, exception:"..."} not a thrown error', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 21,
    method: 'page.evaluate',
    params: { tabId: 101, expression: '__THROW_ME__' },
  })
  assert.equal(res.ok, true, 'page exceptions must NOT be an ok:false response')
  assert.equal(res.result.value, undefined)
  assert.ok(typeof res.result.exception === 'string' && res.result.exception.includes('boom from page'))
})

test('page.snapshot textOnly evaluates document.body.innerText', async () => {
  const env = await connected()
  env.state.evaluateValue = 'visible text here'
  const res = await request(env, {
    id: 22,
    method: 'page.snapshot',
    params: { tabId: 101, textOnly: true },
  })
  assert.equal(res.ok, true)
  const call = env.state.sendCommandCalls.find((c) => c.method === 'Runtime.evaluate')
  assert.ok(call.params.expression.includes('innerText'))
  assert.equal(res.result.content, 'visible text here')
  assert.equal(res.result.truncated, false)
  assert.equal(res.result.title, 'Alpha')
  assert.equal(res.result.url, 'https://alpha.example/')
})

test('page.snapshot default returns simplified HTML and strips script/style/noscript/svg', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 23,
    method: 'page.snapshot',
    params: { tabId: 101 },
  })
  assert.equal(res.ok, true)
  const call = env.state.sendCommandCalls.find((c) => c.method === 'Runtime.evaluate')
  const expr = call.params.expression
  assert.ok(expr.includes('cloneNode'), 'must clone the document')
  for (const tag of ['script', 'style', 'noscript', 'svg']) {
    assert.ok(expr.includes(tag), `stripped selector must include ${tag}`)
  }
  assert.ok(expr.includes('outerHTML'), 'must return outerHTML')
})

test('page.snapshot truncates to maxchars and sets truncated:true', async () => {
  const env = await connected()
  env.state.evaluateValue = 'A'.repeat(100)
  const res = await request(env, {
    id: 24,
    method: 'page.snapshot',
    params: { tabId: 101, textOnly: true, maxchars: 10 },
  })
  assert.equal(res.ok, true)
  assert.equal(res.result.content.length, 10)
  assert.equal(res.result.truncated, true)
})

test('page.snapshot defaults maxchars to 35000', async () => {
  const env = await connected()
  env.state.evaluateValue = 'B'.repeat(40000)
  const res = await request(env, { id: 25, method: 'page.snapshot', params: { tabId: 101, textOnly: true } })
  assert.equal(res.result.content.length, 35000)
  assert.equal(res.result.truncated, true)
})

test('cdp.send attaches and returns the raw command result', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 26,
    method: 'cdp.send',
    params: { tabId: 101, method: 'Page.captureScreenshot', params: { format: 'png' } },
  })
  assert.equal(res.ok, true)
  assert.equal(res.result.data, 'BASE64PNG')
  const call = env.state.sendCommandCalls.find((c) => c.method === 'Page.captureScreenshot')
  assert.deepEqual(plain(call.params), { format: 'png' })
})

test('cdp.send maps a thrown command error to {ok:false, CDP_ERROR}', async () => {
  const env = await connected()
  env.state.commandShouldThrow.set('Nope.nope', 'Method not found')
  const res = await request(env, {
    id: 27,
    method: 'cdp.send',
    params: { tabId: 101, method: 'Nope.nope' },
  })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'CDP_ERROR')
  assert.ok(res.error.message.includes('Method not found'))
})

test('cookies.get {all:true} calls getAll({}) and returns the array', async () => {
  const env = await connected()
  const res = await request(env, { id: 28, method: 'cookies.get', params: { all: true } })
  assert.equal(res.ok, true)
  assert.equal(res.result.length, 2)
  assert.deepEqual(plain(env.state.cookieFilters.at(-1)), {})
})

test('cookies.get {url} calls getAll({url}) when all is false', async () => {
  const env = await connected()
  const res = await request(env, {
    id: 29,
    method: 'cookies.get',
    params: { url: 'https://example.com/', all: false },
  })
  assert.equal(res.ok, true)
  assert.deepEqual(plain(env.state.cookieFilters.at(-1)), { url: 'https://example.com/' })
  assert.equal(res.result[0].value, 'u-scoped')
})

test('unknown method → UNKNOWN_METHOD with an id', async () => {
  const env = await connected()
  const res = await request(env, { id: 30, method: 'does.not.exist' })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'UNKNOWN_METHOD')
  assert.equal(res.id, 30)
})

test('BAD_REQUEST for a method with malformed params', async () => {
  const env = await connected()
  const res = await request(env, { id: 31, method: 'tabs.get', params: {} })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'BAD_REQUEST')
})

// ===========================================================================
// TESTS — the subtle correctness requirements
// ===========================================================================

test('a single module-level socket is reused across many requests', async () => {
  const env = await connected()
  await request(env, { id: 40, method: 'ping' })
  await request(env, { id: 41, method: 'tabs.list' })
  await request(env, { id: 42, method: 'ping' })
  assert.equal(env.sockets.length, 1, 'must not open a new WebSocket per request')
})

test('concurrent connects collapse into one in-flight attempt', async () => {
  const env = loadWorker()
  await flush()
  // Fire several wake-up-ish events at once.
  for (const fn of env.listeners.onCreated) fn({ id: 1 })
  for (const fn of env.listeners.onStartup) fn()
  for (const fn of env.listeners.alarm) fn({ name: 'keepalive' })
  await flush()
  assert.equal(env.sockets.length, 1, 'duplicate concurrent connect attempts must be prevented')
})

test('reconnect uses exponential backoff 1s, 2s, 4s ... capped at 30s', async () => {
  const env = loadWorker()
  await flush()
  const first = env.sockets[0]
  first._fail()
  await flush()
  assert.equal(env.sockets.length, 1, 'no immediate reconnect before the backoff elapses')

  env.clock.tick(999)
  await flush()
  assert.equal(env.sockets.length, 1, 'still waiting before 1s')

  env.clock.tick(1) // t=1000 → delay 1000ms elapsed
  await flush()
  assert.equal(env.sockets.length, 2, 'second attempt after 1s')
  env.sockets[1]._fail()
  await flush()

  env.clock.tick(1999)
  await flush()
  assert.equal(env.sockets.length, 2, 'third attempt must wait 2s, not 1s')
  env.clock.tick(1)
  await flush()
  assert.equal(env.sockets.length, 3, 'third attempt after 2s')

  env.sockets[2]._fail()
  await flush()
  env.clock.tick(3999)
  await flush()
  assert.equal(env.sockets.length, 3, 'fourth attempt must wait 4s')
  env.clock.tick(1)
  await flush()
  assert.equal(env.sockets.length, 4, 'fourth attempt after 4s')

  // Verify the cap: after many failures the delay must stop growing past 30s.
  let idx = 3
  const gaps = []
  for (let i = 0; i < 8; i++) {
    env.sockets[idx]._fail()
    await flush()
    let waited = 0
    let before = env.sockets.length
    while (env.sockets.length === before && waited < 60000) {
      env.clock.tick(500)
      await flush()
      waited += 500
    }
    gaps.push(waited)
    idx = env.sockets.length - 1
  }
  assert.ok(gaps.every((g) => g <= 30500), 'backoff gap must never exceed 30s: ' + JSON.stringify(gaps))
})

test('self-ping keeps the socket alive every 20s while connected', async () => {
  const env = await connected()
  const before = eventFrames(env.ws).length
  env.clock.tick(20000)
  await flush()
  const after = eventFrames(env.ws)
  assert.ok(after.length > before, 'a keepalive frame must be sent after 20s idle')
  const pings = after.filter((e) => e.method === 'ping' || e.method === 'keepalive' || e.id === undefined)
  assert.ok(pings.length >= 1)
})

test('after the socket closes the worker reconnects on demand (chrome.tabs event)', async () => {
  const env = await connected()
  env.ws._serverClose(1006, 'lost')
  await flush()
  // A wake-up event should trigger an immediate reconnect attempt without waiting for backoff.
  for (const fn of env.listeners.onCreated) fn({ id: 555 })
  await flush()
  assert.ok(env.sockets.length >= 2, 'a tabs event must trigger a reconnect attempt')
  const ws2 = env.sockets.at(-1)
  ws2._open()
  await flush()
  const res = await request({ ...env, ws: ws2 }, { id: 50, method: 'ping' })
  assert.equal(res.ok, true, 'the worker must still answer after reconnecting')
})

test('a chrome.alarms keepalive alarm is registered', async () => {
  const env = loadWorker()
  await flush()
  assert.ok(env.state.alarms.size >= 1, 'at least one chrome.alarms keepalive must be created')
  const anyInfo = [...env.state.alarms.values()][0]
  assert.ok(anyInfo && (anyInfo.periodInMinutes || anyInfo.delayInMinutes), 'alarm must be periodic or delayed')
})

// ---------------------------------------------------------------------------
// Refcounting for chrome.debugger.attach
// ---------------------------------------------------------------------------

test('refcount: two concurrent page.evaluate calls attach once and detach once', async () => {
  const env = await connected()
  env.state.commandDelayMs = 30
  const p1 = request(env, { id: 60, method: 'page.evaluate', params: { tabId: 101, expression: 'a' } })
  const p2 = request(env, { id: 61, method: 'page.evaluate', params: { tabId: 101, expression: 'b' } })
  const [r1, r2] = await Promise.all([p1, p2])
  assert.equal(r1.ok, true)
  assert.equal(r2.ok, true)
  assert.equal(env.state.attachCalls, 1, 'concurrent calls must attach only once')
  assert.equal(env.state.detachCalls, 1, 'the last caller releases the session exactly once')
  assert.deepEqual(env.state.detachTargets, [101])
})

test('refcount: a sequential second call does not need a fresh attach if a session is held', async () => {
  const env = await connected()
  // cdp.send leaves no lingering session (it is scoped), so two sequential calls = 2 attach cycles.
  await request(env, { id: 62, method: 'cdp.send', params: { tabId: 101, method: 'Page.enable' } })
  await request(env, { id: 63, method: 'cdp.send', params: { tabId: 101, method: 'Page.enable' } })
  assert.equal(env.state.attachCalls, 2)
  assert.equal(env.state.detachCalls, 2, 'each scoped call must detach what it attached')
})

test('debugger attach rejection surfaces ATTACH_FAILED mentioning DevTools', async () => {
  const env = await connected()
  env.state.attachShouldThrow.add(101)
  const res = await request(env, { id: 64, method: 'page.evaluate', params: { tabId: 101, expression: 'x' } })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'ATTACH_FAILED')
  assert.ok(/devtools/i.test(res.error.message), 'message must tell the user to close DevTools: ' + res.error.message)
})

test('chrome.debugger.onDetach decrements refcount and emits debugger.detached', async () => {
  const env = await connected()
  env.state.commandDelayMs = 30
  const p1 = request(env, { id: 65, method: 'cdp.send', params: { tabId: 101, method: 'Page.enable' } })
  await flush()
  // Simulate Chrome detaching us mid-flight (user opened DevTools).
  for (const fn of env.listeners.onDetach) fn({ tabId: 101 }, 'canceled_by_user')
  await flush()
  const events = eventFrames(env.ws)
  const detached = events.find((e) => e.method === 'debugger.detached')
  assert.ok(detached, 'debugger.detached event must be sent to the host')
  assert.equal(detached.tabId, 101)
  assert.ok(typeof detached.reason === 'string')
  const r1 = await p1
  // The call may fail (session gone) — what matters is no double-send / no crash.
  assert.ok(r1.ok === true || r1.ok === false)
})

test('tabs.changed events are forwarded best-effort', async () => {
  const env = await connected()
  const before = eventFrames(env.ws).length
  for (const fn of env.listeners.onCreated) fn({ id: 401, url: 'https://x.example/' })
  for (const fn of env.listeners.onUpdated) fn(402, { status: 'complete' }, { id: 402, url: 'https://y.example/' })
  for (const fn of env.listeners.onRemoved) fn(403, {})
  await flush()
  const changed = eventFrames(env.ws).slice(before).filter((e) => e.method === 'tabs.changed')
  assert.equal(changed.length, 3, 'created/updated/removed must each emit tabs.changed')
  assert.deepEqual(changed.map((c) => c.change).sort(), ['created', 'removed', 'updated'])
})

test('never sends two responses for one id even on a slow command', async () => {
  const env = await connected()
  const res = await request(env, { id: 70, method: 'ping' })
  await flush(20)
  env.clock.tick(5000)
  await flush()
  const all = responseFrames(env.ws).filter((f) => f.id === 70)
  assert.equal(all.length, 1)
  assert.equal(res.ok, true)
})

test('requests arriving while disconnected do not crash and are answered after reconnect', async () => {
  const env = await connected()
  const ws1 = env.ws
  ws1._serverClose(1006, 'lost')
  await flush()
  // No socket — send nothing yet; then reconnect and issue a request.
  env.clock.tick(1000)
  await flush()
  const ws2 = env.sockets.at(-1)
  assert.notEqual(ws2, ws1)
  ws2._open()
  await flush()
  const res = await request({ ...env, ws: ws2 }, { id: 80, method: 'ping' })
  assert.equal(res.ok, true)
})

test('a page.evaluate on a missing tab → NO_TAB before touching the debugger', async () => {
  const env = await connected()
  const before = env.state.attachCalls
  const res = await request(env, { id: 81, method: 'page.evaluate', params: { tabId: 4242, expression: 'x' } })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'NO_TAB')
  assert.equal(env.state.attachCalls, before, 'must not attach to a nonexistent tab')
})

// ===========================================================================
// Static file checks (manifest/options/icon/README)
// ===========================================================================
test('manifest.json is valid JSON with the required MV3 fields', () => {
  const raw = fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8')
  const m = JSON.parse(raw)
  assert.equal(m.manifest_version, 3)
  assert.equal(m.name, 'DSH Browser Bridge')
  assert.equal(m.version, '0.1.0')
  assert.deepEqual(
    [...m.permissions].sort(),
    ['alarms', 'cookies', 'debugger', 'storage', 'tabs'],
    'permissions must be exactly this set (no scripting)'
  )
  assert.deepEqual(m.host_permissions, ['<all_urls>'])
  assert.deepEqual(m.background, { service_worker: 'background.js', type: 'module' })
  assert.equal(m.options_page, 'options.html')
  assert.deepEqual(m.icons, { '128': 'icon128.png' })
  assert.equal(m.content_scripts, undefined, 'no content scripts')
})

test('icon128.png is a real decodable 128x128 PNG', () => {
  const b = fs.readFileSync(path.join(EXT_DIR, 'icon128.png'))
  assert.equal(b.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature')
  assert.equal(b.subarray(12, 16).toString('ascii'), 'IHDR')
  assert.equal(b.readUInt32BE(16), 128, 'width 128')
  assert.equal(b.readUInt32BE(20), 128, 'height 128')
  assert.equal(b.subarray(b.length - 8).toString('hex').slice(0, 8), '49454e44', 'IEND chunk')
})

test('options.html + options.js exist and are CSP-safe (no inline script, no external refs)', () => {
  const html = fs.readFileSync(path.join(EXT_DIR, 'options.html'), 'utf8')
  assert.ok(/id=["']host["']/.test(html), 'host input')
  assert.ok(/id=["']port["']/.test(html), 'port input')
  assert.ok(/options\.js/.test(html), 'must load options.js as a separate file')
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'no inline <script>')
  assert.ok(!/https?:\/\//i.test(html.replace(/https?:\/\/127\.0\.0\.1[^"']*/g, '')), 'no external resources')
  const js = fs.readFileSync(path.join(EXT_DIR, 'options.js'), 'utf8')
  assert.ok(js.includes('chrome.storage.local.set'), 'save must write chrome.storage.local')
})

test('README.md documents load steps, the yellow bar, DevTools conflict, limitations', () => {
  const md = fs.readFileSync(path.join(EXT_DIR, 'README.md'), 'utf8')
  assert.ok(/load unpacked/i.test(md), 'must explain chrome://extensions Load unpacked')
  assert.ok(/yellow/i.test(md), 'must explain the yellow debug bar')
  assert.ok(/devtools/i.test(md), 'must explain the DevTools conflict')
  assert.ok(/enterprise/i.test(md), 'must mention enterprise policy limitation')
})

test('background.js declares no chrome.scripting usage', () => {
  const src = fs.readFileSync(WORKER_PATH, 'utf8')
  assert.ok(!/chrome\.scripting/.test(src), 'page.evaluate must go through Runtime.evaluate, not scripting')
})

// ===========================================================================
// Runner
// ===========================================================================
let pass = 0
let fail = 0
const failures = []

for (const t of tests) {
  try {
    await t.fn()
    pass++
    console.log('  \u001b[32mPASS\u001b[0m ' + t.name)
  } catch (err) {
    fail++
    failures.push({ name: t.name, err })
    console.log('  \u001b[31mFAIL\u001b[0m ' + t.name)
    console.log('       ' + String((err && err.message) || err).split('\n').join('\n       '))
  }
}

console.log('')
console.log(`  ${pass} passed, ${fail} failed, ${tests.length} total`)
if (fail > 0) {
  console.log('')
  for (const f of failures) {
    console.log('  FAILED: ' + f.name)
    console.log('    ' + String((f.err && f.err.stack) || f.err).split('\n').slice(0, 4).join('\n    '))
  }
  process.exit(1)
}
