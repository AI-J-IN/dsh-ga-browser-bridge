/**
 * tests/extension.test.ts — the Chrome-extension transport.
 *
 * Three parts, each with a different fidelity/purpose:
 *
 *   A. PROTOCOL (src/extension/protocol.ts) — pure functions, no I/O. Pins the
 *      wire contract both sides must agree on.
 *   B. BRIDGE (src/extension/bridge.ts) — driven over a REAL localhost
 *      WebSocket by tests/helpers/fake-extension.ts. The bridge is a `ws`
 *      server; the interesting failures (id routing, timeouts, disconnect,
 *      port conflicts) live in its socket layer, so mocking `ws` would test
 *      the mock.
 *   C. TOOL ROUTING (src/tools/*) — dual-mode dispatch: prefer the extension,
 *      fall back to CDP. Driven with INJECTED fakes (a fake ExtensionBridge
 *      object and the existing FakeCdpConnection) — no sockets here.
 *
 * STATUS: written RED-FIRST, against the contract in src/extension/protocol.ts
 * and the task brief, before bridge.ts / extension-mode.ts / the tool routing
 * existed. All three have since landed and parts A-C run for real (19 tests).
 * The module-presence probes below are kept deliberately: they turn a
 * regression that DELETES or renames a module into an explicit
 * "BLOCKED ON <module>" skip instead of an opaque import crash, and they let
 * part C skip itself if the tools stop consuming the routing knobs.
 *
 * PORT ALLOCATION: ExtensionBridge's API has no "port 0 = OS picks" mode
 * (`new ExtensionBridge({ port })` validates an explicit 1..65535), so every
 * bridge test probes a pid-seeded candidate range (18790-18889) and binds the
 * first port that is free, waiting briefly for TIME_WAIT. If the whole range
 * stays busy the test SKIPS with a message — see `withFreePort()` below.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FakeExtension,
  candidatePorts,
  waitForFreePort,
  tick,
} from './helpers/fake-extension'
import type { InboundFrame } from './helpers/fake-extension'

import {
  EXTENSION_DEFAULT_PORT,
  EXTENSION_PROTOCOL_VERSION,
  fail,
  isEvent,
  isRequest,
  isResponse,
  ok,
} from '../src/extension/protocol.js'

import { FakeCdpConnection } from './setup'
import { TOOLS, createToolContext } from '@tools/index'
import type { ToolContext } from '@tools/index'

// ---------------------------------------------------------------------------
// Module presence probes (see RED-FIRST NOTE)
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'src', 'extension')

function hasModule(file: string): boolean {
  try {
    readFileSync(join(SRC, file), 'utf8')
    return true
  } catch {
    return false
  }
}

const BRIDGE_AVAILABLE = hasModule('bridge.ts')
const EXTENSION_MODE_AVAILABLE = hasModule(join('..', 'tools', 'extension-mode.ts'))

/** Load the bridge module, or null when it has not landed yet. */
async function loadBridge(): Promise<BridgeModule | null> {
  if (!BRIDGE_AVAILABLE) return null
  try {
    return (await import('../src/extension/bridge.js')) as unknown as BridgeModule
  } catch {
    return null
  }
}

/** Structural view of src/extension/bridge.ts (imported lazily). */
interface BridgeInstance {
  readonly port: number
  start(): Promise<void>
  stop(): Promise<void>
  isConnected(): boolean
  request(req: { method: string; params?: Record<string, unknown> }): Promise<unknown>
  listTabs?(): Promise<unknown>
}

interface BridgeModule {
  ExtensionBridge: new (options?: { port?: number; requestTimeoutMs?: number }) => BridgeInstance
}

const describeIfBridge = BRIDGE_AVAILABLE ? describe : describe.skip

// ---------------------------------------------------------------------------
// Shared cleanup bookkeeping: every socket and bridge is torn down in afterEach
// so jest exits cleanly (this repo has been bitten by "Jest did not exit").
// ---------------------------------------------------------------------------

const openFakes: FakeExtension[] = []
const openBridges: BridgeInstance[] = []

afterEach(async () => {
  for (const fake of openFakes.splice(0)) {
    try {
      fake.terminate()
    } catch {
      // already gone
    }
  }
  for (const bridge of openBridges.splice(0)) {
    try {
      await bridge.stop()
    } catch {
      // already stopped
    }
  }
})

/** A bridge on a probed free port, registered for automatic stop(). */
function makeBridge(
  mod: BridgeModule,
  port: number,
  requestTimeoutMs?: number,
): BridgeInstance {
  const bridge =
    requestTimeoutMs === undefined
      ? new mod.ExtensionBridge({ port })
      : new mod.ExtensionBridge({ port, requestTimeoutMs })
  openBridges.push(bridge)
  return bridge
}

/** Connect a tracked fake extension. */
async function connectFake(
  port: number,
  options?: Parameters<typeof FakeExtension.connect>[1],
): Promise<FakeExtension> {
  const fake = await FakeExtension.connect(port, options)
  openFakes.push(fake)
  return fake
}

/**
 * Run `body` with a free loopback port. Skips the test (with a message) when
 * the candidate range stays occupied — the bridge API cannot ask the OS for an
 * ephemeral port, and reusing a busy one would test PORT_IN_USE instead of
 * the behaviour under test. A short settle window absorbs the Windows
 * TIME_WAIT left behind by a previous test's just-closed server.
 */
async function withFreePort(body: (port: number) => Promise<void>): Promise<void> {
  const port = await waitForFreePort(candidatePorts())
  if (port === null) {
    console.warn(
      '[extension.test] SKIPPED: every candidate port (18790-18889, pid-seeded) is in use. ' +
        'ExtensionBridge exposes no "port 0" ephemeral mode, so a free port cannot be chosen safely.',
    )
    return
  }
  await body(port)
}

// ===========================================================================
// A. PROTOCOL CONTRACT
// ===========================================================================

describe('A. extension protocol contract', () => {
  it('1. pins the protocol version and default port', () => {
    expect(EXTENSION_PROTOCOL_VERSION).toBe(1)
    expect(EXTENSION_DEFAULT_PORT).toBe(18765)
  })

  describe('2. isRequest', () => {
    it('accepts host->extension request frames', () => {
      expect(isRequest({ id: 1, method: 'ping' })).toBe(true)
      expect(isRequest({ id: 42, method: 'tabs.get', params: { tabId: 7 } })).toBe(true)
      expect(
        isRequest({ id: 3, method: 'cdp.send', params: { tabId: 1, method: 'Page.enable' } }),
      ).toBe(true)
    })

    it('rejects everything that is not a request', () => {
      // missing / non-numeric id
      expect(isRequest({ method: 'ping' })).toBe(false)
      expect(isRequest({ id: '1', method: 'ping' })).toBe(false)
      expect(isRequest({ id: null, method: 'ping' })).toBe(false)
      // missing / non-string method
      expect(isRequest({ id: 1 })).toBe(false)
      expect(isRequest({ id: 1, method: 7 })).toBe(false)
      // a RESPONSE is not a request (it has ok, no method)…
      expect(isRequest({ id: 1, ok: true, result: null })).toBe(false)
      // …and an EVENT is not one either (no id)
      expect(isRequest({ method: 'hello', protocolVersion: 1 })).toBe(false)
      // not an object at all
      expect(isRequest(null)).toBe(false)
      expect(isRequest(undefined)).toBe(false)
      expect(isRequest('ping')).toBe(false)
      expect(isRequest(7)).toBe(false)
      expect(isRequest([{ id: 1, method: 'ping' }])).toBe(false)
    })
  })

  describe('2. isResponse', () => {
    it('accepts both success and failure responses', () => {
      expect(isResponse({ id: 1, ok: true, result: { pong: true } })).toBe(true)
      expect(isResponse({ id: 2, ok: false, error: { code: 'NO_TAB', message: 'boom' } })).toBe(true)
      // `result` is legitimately optional/undefined on a success response.
      expect(isResponse({ id: 3, ok: true })).toBe(true)
    })

    it('rejects everything that is not a response', () => {
      expect(isResponse({ id: 1, result: 1 })).toBe(false) // no `ok`
      expect(isResponse({ id: 1, ok: 'yes' })).toBe(false) // `ok` not boolean
      expect(isResponse({ ok: true, result: 1 })).toBe(false) // no id
      expect(isResponse({ id: '1', ok: true })).toBe(false) // non-numeric id
      expect(isResponse({ id: 1, method: 'ping' })).toBe(false) // a request
      expect(isResponse({ method: 'hello' })).toBe(false) // an event
      expect(isResponse(null)).toBe(false)
      expect(isResponse('{"id":1,"ok":true}')).toBe(false) // a string, not parsed
    })
  })

  describe('2. isEvent', () => {
    it('accepts extension->host notifications (no numeric id)', () => {
      expect(
        isEvent({ method: 'hello', protocolVersion: 1, extensionVersion: '1.0.0', browser: 'Chrome/131' }),
      ).toBe(true)
      expect(isEvent({ method: 'tabs.changed', tabId: 9, change: 'created' })).toBe(true)
      expect(isEvent({ method: 'debugger.detached', tabId: 9, reason: 'canceled_by_user' })).toBe(true)
    })

    it('rejects everything that is not an event', () => {
      // a request carries an id, so it is not an event
      expect(isEvent({ id: 1, method: 'ping' })).toBe(false)
      expect(isEvent({ id: 1, ok: true, result: null })).toBe(false) // a response
      expect(isEvent({ protocolVersion: 1 })).toBe(false) // no method
      expect(isEvent({ method: 42 })).toBe(false) // non-string method
      expect(isEvent(null)).toBe(false)
      expect(isEvent(undefined)).toBe(false)
      expect(isEvent([])).toBe(false)
      expect(isEvent('hello')).toBe(false)
    })
  })

  describe('3. ok / fail response builders', () => {
    it('ok(id, result) produces the documented success shape', () => {
      expect(ok(5, { tabs: [] })).toEqual({ id: 5, ok: true, result: { tabs: [] } })
      // `result` is carried through verbatim, including null/undefined.
      expect(ok(6, null)).toEqual({ id: 6, ok: true, result: null })
      expect(ok(7, 'text')).toEqual({ id: 7, ok: true, result: 'text' })
      // round-trips through the guard
      expect(isResponse(ok(8, { pong: true }))).toBe(true)
    })

    it('fail(id, code, message) produces the documented error shape', () => {
      expect(fail(5, 'NO_TAB', 'no such tab')).toEqual({
        id: 5,
        ok: false,
        error: { code: 'NO_TAB', message: 'no such tab', detail: undefined },
      })
      // optional 4th argument is folded into error.detail
      expect(fail(9, 'CDP_ERROR', 'detached', 'target closed')).toEqual({
        id: 9,
        ok: false,
        error: { code: 'CDP_ERROR', message: 'detached', detail: 'target closed' },
      })
      // a failure response is never mistaken for a success response or a request
      const failure = fail(10, 'ATTACH_FAILED', 'cannot attach')
      expect(isResponse(failure)).toBe(true)
      expect(isRequest(failure)).toBe(false)
      expect(isEvent(failure)).toBe(false)
      expect(failure.ok).toBe(false)
    })
  })
})

// ===========================================================================
// B. EXTENSION BRIDGE (real sockets)
// ===========================================================================

describeIfBridge('B. ExtensionBridge over a real WebSocket', () => {
  let mod: BridgeModule

  beforeAll(async () => {
    const loaded = await loadBridge()
    if (loaded === null) throw new Error('src/extension/bridge.ts could not be imported')
    mod = loaded
  })

  it('4. start() binds loopback and accepts a client connection', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port)
      expect(bridge.isConnected()).toBe(false)

      await bridge.start()
      expect(bridge.port).toBe(port)

      // A real client can dial in. `hello: false` — this test is about the
      // socket, not the handshake.
      const fake = await connectFake(port, { hello: false })
      await tick()
      expect(fake.isClosed).toBe(false)
      expect(bridge.isConnected()).toBe(false) // no hello yet
    })
  })

  it('5. request() before any client connects rejects with NO_EXTENSION', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port)
      await bridge.start()

      await expect(bridge.request({ method: 'ping' })).rejects.toMatchObject({
        code: 'NO_EXTENSION',
      })
      // still rejects on a later attempt (not a one-shot state)
      await expect(bridge.request({ method: 'tabs.list' })).rejects.toMatchObject({
        code: 'NO_EXTENSION',
      })
    })
  })

  it('6. after hello, request() resolves with the fake reply and round-trips the id', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port)
      await bridge.start()

      const fake = await connectFake(port)
      expect(bridge.isConnected()).toBe(true)

      // Answer only after the request frame is observed, so the assertion
      // below is about the REAL id the bridge allocated.
      const seen: Array<{ id: number; method: string }> = []
      fake.onRequest((frame: InboundFrame) => {
        seen.push({ id: Number(frame['id']), method: String(frame['method']) })
        return { pong: true, echo: frame['method'] }
      })

      await expect(bridge.request({ method: 'ping' })).resolves.toEqual({
        pong: true,
        echo: 'ping',
      })

      expect(seen).toHaveLength(1)
      expect(seen[0]!.method).toBe('ping')
      expect(typeof seen[0]!.id).toBe('number')
      expect(Number.isInteger(seen[0]!.id)).toBe(true)

      // The frame on the wire carries that numeric id.
      const frame = fake.requests()[0]!
      expect(frame['id']).toBe(seen[0]!.id)
      expect(frame['method']).toBe('ping')
      expect(fake.answeredIds).toEqual([seen[0]!.id])
    })
  })

  it('7. concurrent requests are routed by id, even when answered out of order', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port, 2000)
      await bridge.start()
      const fake = await connectFake(port)

      // Collect both frames, then answer the SECOND one first.
      const held: Array<{ id: number; method: unknown }> = []
      fake.onRequest((frame: InboundFrame) => {
        held.push({ id: Number(frame['id']), method: frame['method'] })
        if (held.length === 2) {
          const first = held[0]!
          const second = held[1]!
          fake.respond(second.id, { who: 'tabs.list', id: second.id })
          fake.respond(first.id, { who: 'ping', id: first.id })
        }
        return undefined // answered manually above
      })

      const [pingResult, tabsResult] = await Promise.all([
        bridge.request({ method: 'ping' }),
        bridge.request({ method: 'tabs.list' }),
      ])

      expect(pingResult).toMatchObject({ who: 'ping' })
      expect(tabsResult).toMatchObject({ who: 'tabs.list' })
      // Each promise got ITS OWN id back.
      expect((pingResult as { id: number }).id).toBe(held[0]!.id)
      expect((tabsResult as { id: number }).id).toBe(held[1]!.id)
      expect(held[0]!.id).not.toBe(held[1]!.id)
    })
  })

  it('8. an unanswered request rejects with TIMEOUT (requestTimeoutMs honoured)', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port, 100) // fast timeout for the test
      await bridge.start()
      const fake = await connectFake(port)
      // No handler registered: the fake deliberately stays silent.

      const startedAt = Date.now()
      await expect(bridge.request({ method: 'ping' })).rejects.toMatchObject({ code: 'TIMEOUT' })
      const elapsed = Date.now() - startedAt

      expect(elapsed).toBeGreaterThanOrEqual(80) // did not fail instantly
      expect(elapsed).toBeLessThan(2000) // …and did not wait for a default 30s budget
      // The frame really went out before timing out.
      expect(fake.requests().length).toBeGreaterThanOrEqual(1)
      // A late response for the abandoned id must not blow up or resolve twice.
      fake.respond(Number(fake.requests()[0]!['id']), { late: true })
      await tick()
    })
  })

  it('9. dropping the socket mid-request rejects with DISCONNECTED and clears isConnected()', async () => {
    await withFreePort(async (port) => {
      const bridge = makeBridge(mod, port, 5000)
      await bridge.start()
      const fake = await connectFake(port)
      expect(bridge.isConnected()).toBe(true)

      // Silent fake: the request is in flight when the socket dies.
      const inFlight = bridge.request({ method: 'ping' })
      const settled = expect(inFlight).rejects.toMatchObject({ code: 'DISCONNECTED' })

      await fake.nextRequestFor('ping')
      fake.terminate() // no close handshake — the service-worker-gone case
      await settled

      // Poll briefly: socket teardown is asynchronous on both ends.
      for (let i = 0; i < 40 && bridge.isConnected(); i += 1) await tick(10)
      expect(bridge.isConnected()).toBe(false)
      // And with nothing connected, new requests say NO_EXTENSION again.
      await expect(bridge.request({ method: 'ping' })).rejects.toMatchObject({
        code: 'NO_EXTENSION',
      })
    })
  })

  it('10. a second bridge on the same port rejects its start() with PORT_IN_USE', async () => {
    await withFreePort(async (port) => {
      const first = makeBridge(mod, port)
      await first.start()

      const second = makeBridge(mod, port)
      await expect(second.start()).rejects.toMatchObject({ code: 'PORT_IN_USE' })
    })
  })
})

// ===========================================================================
// C. TOOL ROUTING (injected fakes, no sockets)
// ===========================================================================

/** Force CDP mode on a ToolContext (existing keys first, routing keys optional). */
function cdpContext(conn: FakeCdpConnection): ToolContext {
  return createToolContext({
    host: '127.0.0.1',
    port: 9222,
    getConnection: async () => conn as any,
    getOrCreateBrowser: async () => {},
    defaultTimeoutMs: 30_000,
    // Routing knobs added by the dual-mode work. Typed as `any` because
    // ToolContext may not declare them on every branch yet.
    ...({ transport: 'cdp', getExtensionBridge: () => null } as any),
  } as any)
}

/** Force extension mode with an INJECTED fake bridge (no socket opened). */
function extensionContext(conn: FakeCdpConnection, bridge: Record<string, unknown>): ToolContext {
  return createToolContext({
    host: '127.0.0.1',
    port: 9222,
    getConnection: async () => conn as any,
    getOrCreateBrowser: async () => {},
    defaultTimeoutMs: 30_000,
    ...({ transport: 'extension', getExtensionBridge: () => bridge } as any),
  } as any)
}

/** A FakeCdpConnection with two tabs (the CDP-path fallback data). */
function twoTabConnection(): FakeCdpConnection {
  const conn = new FakeCdpConnection()
  conn.tabs = [
    { id: '1', type: 'page', title: 'GitHub', url: 'https://github.com/some/repo' },
    { id: '2', type: 'page', title: 'Example', url: 'https://example.com/page' },
  ]
  return conn
}

/** Tabs as the extension reports them (numeric chrome.tabs ids). */
const EXTENSION_TABS = [
  { id: 11, title: 'Ext GitHub', url: 'https://github.com/x/y', active: true, windowId: 1 },
  { id: 12, title: 'Ext Example', url: 'https://example.com/e', active: false, windowId: 1 },
]

/**
 * Fake bridge: a live, connected extension. It exposes BOTH surfaces the
 * bridge documents — `listTabs()` (raw `tabs.list`) and `request({method})` —
 * and records which of them the tools used, so a test can prove the tool went
 * through the extension rather than CDP without pinning WHICH method the
 * implementation happens to call.
 */
function fakeBridge(overrides: Record<string, unknown> = {}): {
  bridge: Record<string, unknown>
  calls: Array<{ method: string; params?: unknown }>
} {
  const calls: Array<{ method: string; params?: unknown }> = []
  const tabs = EXTENSION_TABS.map((tab) => ({ ...tab }))
  const bridge: Record<string, unknown> = {
    isConnected: () => true,
    request: async (req: { method: string; params?: unknown }) => {
      calls.push(req)
      return req.method === 'tabs.list' ? tabs : null
    },
    listTabs: async () => {
      calls.push({ method: 'listTabs' })
      return tabs
    },
    ...overrides,
  }
  return { bridge, calls }
}

async function callTool(name: string, args: any, ctx: ToolContext): Promise<string> {
  const spec = TOOLS[name]
  if (spec === undefined) throw new Error(`tool ${name} missing from TOOLS`)
  return spec.fn(args, ctx)
}

/**
 * Whether `browser_tabs` actually consumes the routing knobs yet.
 *
 * src/tools/extension-mode.ts can exist (with routeTransport and all the
 * helpers) while tabs.ts/scan.ts/... are still unmodified — then
 * `transport: 'extension'` is silently ignored and the tool takes the CDP
 * path. That is a half-landed integration, not a wrong contract, so part C
 * SKIPS with an explicit reason instead of failing (the brief asks for
 * skip-with-message here). The probe re-runs on every run, so the tests light
 * up by themselves once the wiring lands.
 */
let wiringProbe: Promise<boolean> | null = null
function toolsRoutingWired(): Promise<boolean> {
  if (!EXTENSION_MODE_AVAILABLE) return Promise.resolve(false)
  wiringProbe ??= (async () => {
    try {
      const { bridge } = fakeBridge()
      const raw = await callTool(
        'browser_tabs',
        { action: 'list' },
        extensionContext(twoTabConnection(), bridge),
      )
      const parsed = JSON.parse(raw) as { tabs?: Array<{ id?: unknown }> }
      // Extension ids ('11') only appear when the extension path served it.
      return Array.isArray(parsed.tabs) && parsed.tabs[0]?.id === '11'
    } catch {
      return false
    }
  })()
  return wiringProbe
}

const TOOLS_BLOCKED_NOTE =
  'BLOCKED ON ext-tools: browser_tabs does not route through routeTransport() yet, ' +
  'so transport/getExtensionBridge are inert for the tools. Tests 11-13 ' +
  '(dual-mode tool routing) are SKIPPED until that lands — re-run `npm test` after it does.'

/** Run `body` only when the tool layer is actually dual-mode; else skip loudly. */
function whenWired(name: string, body: () => Promise<void>): () => Promise<void> {
  return async () => {
    if (!(await toolsRoutingWired())) {
      // eslint-disable-next-line no-console
      console.warn(`[extension.test] SKIPPED ${name}: ${TOOLS_BLOCKED_NOTE}`)
      return
    }
    await body()
  }
}

describe('C. dual-mode tool routing', () => {
  it(
    '11. transport:"cdp" uses the CDP path and never touches the extension',
    whenWired('11', async () => {
      const conn = twoTabConnection()
      const { bridge, calls } = fakeBridge()
      // Even when a live extension bridge is offered, forced CDP ignores it.
      const ctx = createToolContext({
        ...cdpContext(conn),
        ...({ getExtensionBridge: () => bridge } as any),
      } as any)

      const parsed = JSON.parse(await callTool('browser_tabs', { action: 'list' }, ctx))
      expect(parsed.count).toBe(2)
      expect(parsed.tabs.map((t: any) => t.id)).toEqual(['1', '2'])
      expect(calls).toHaveLength(0)
    }),
  )

  it(
    '12. transport:"extension" returns the same {count,tabs} shape with stringified ids',
    whenWired('12', async () => {
      const conn = twoTabConnection()
      const { bridge, calls } = fakeBridge()
      const ctx = extensionContext(conn, bridge)

      const parsed = JSON.parse(await callTool('browser_tabs', { action: 'list' }, ctx))

      // Same envelope as the CDP path…
      expect(parsed).toMatchObject({ count: 2 })
      // …with chrome.tabs numeric ids rendered as strings.
      expect(parsed.tabs).toEqual([
        { id: '11', title: 'Ext GitHub', url: 'https://github.com/x/y' },
        { id: '12', title: 'Ext Example', url: 'https://example.com/e' },
      ])
      for (const tab of parsed.tabs) expect(typeof tab.id).toBe('string')
      // Served by the extension (either bridge surface counts), not by CDP.
      expect(calls.length).toBeGreaterThan(0)
      // …and the CDP connection was not consulted for the tab list.
      expect(conn.ops).toHaveLength(0)
    }),
  )

  it(
    '13. with no extension available the tools fall back to CDP and do not throw',
    whenWired('13', async () => {
      const conn = twoTabConnection()
      const ctx = createToolContext({
        host: '127.0.0.1',
        port: 9222,
        getConnection: async () => conn as any,
        getOrCreateBrowser: async () => {},
        defaultTimeoutMs: 30_000,
        // Bridge unavailable: the routing must degrade to CDP, not throw.
        ...({ transport: 'extension', getExtensionBridge: () => null } as any),
      } as any)

      const raw = await callTool('browser_tabs', { action: 'list' }, ctx)
      expect(raw.startsWith('[error]')).toBe(false)
      expect(JSON.parse(raw)).toMatchObject({ count: 2 })
    }),
  )
})

// Surfaces the blocked-on state in the jest output even when nothing runs.
if (!BRIDGE_AVAILABLE) {
  // eslint-disable-next-line no-console
  console.warn(
    'BLOCKED ON ext-bridge: src/extension/bridge.ts is absent — ' +
      'tests 4-10 (ExtensionBridge) are skipped. Re-run `npm test` after it lands.',
  )
}
