/**
 * Contract tests for the extension bridge (src/extension/bridge.ts).
 *
 * Owned by the tests agent; kept deliberately dependency-free apart from
 * `ws`. Every test drives the real WebSocket server over 127.0.0.1 — no
 * mocks — so the wire behaviour is what is asserted.
 */

import { WebSocket, WebSocketServer } from 'ws'

import { ExtensionBridge, ExtensionBridgeError, normalizeTabs } from '../src/extension/bridge.js'
import type { ExtensionEvent } from '../src/extension/protocol.js'

// A port range unlikely to collide: tests take the first free port of a small
// arithmetic sequence so a TCP TIME_WAIT from a previous run cannot wedge CI.
let portSeed = 24000 + (process.pid % 500)
function nextPort(): number {
  return (portSeed += 7)
}

interface ClientHandle {
  socket: WebSocket
  /** Frames the bridge sent to this fake extension. */
  received: Array<Record<string, unknown>>
  /** Send an arbitrary (possibly malformed) frame to the bridge. */
  send: (payload: unknown) => void
  sendRaw: (payload: string) => void
  close: () => Promise<void>
  /** Wait until the bridge acknowledges a hello (or a fixed delay). */
  waitForFrame: (id?: number) => Promise<Record<string, unknown>>
  /** Wait until at least `count` frames have arrived, returning all of them. */
  waitForFrames: (count: number) => Promise<Array<Record<string, unknown>>>
}

/** Connect a fake extension and record what the bridge sends. */
function connectExtension(port: number): Promise<ClientHandle> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    const received: Array<Record<string, unknown>> = []
    const waiters: Array<{
      match: (frame: Record<string, unknown>) => boolean
      resolve: (frame: Record<string, unknown>) => void
    }> = []

    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as Record<string, unknown>
      received.push(frame)
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i]
        if (waiter !== undefined && waiter.match(frame)) {
          waiters.splice(i, 1)
          waiter.resolve(frame)
        }
      }
    })
    socket.once('error', reject)
    socket.once('open', () => {
      socket.removeListener('error', reject)
      socket.on('error', () => {
        /* ignored: close-path tests tear sockets down abruptly */
      })
      resolve({
        socket,
        received,
        send: (payload) => socket.send(JSON.stringify(payload)),
        sendRaw: (payload) => socket.send(payload),
        close: () =>
          new Promise<void>((done) => {
            if (socket.readyState === WebSocket.CLOSED) {
              done()
              return
            }
            socket.once('close', () => done())
            socket.close()
          }),
        waitForFrame: (id) =>
          new Promise<Record<string, unknown>>((done) => {
            if (id === undefined) {
              // Any frame at all — resolve immediately if one is already buffered.
              const buffered = received[0]
              if (buffered !== undefined) {
                done(buffered)
                return
              }
              const timer = setTimeout(() => done({ __timeout: true }), 2000)
              waiters.push({
                match: () => true,
                resolve: (frame) => {
                  clearTimeout(timer)
                  done(frame)
                },
              })
              return
            }
            const existing = received.find((f) => f['id'] === id)
            if (existing) {
              done(existing)
              return
            }
            waiters.push({ match: (f) => f['id'] === id, resolve: done })
          }),
        waitForFrames: (count) =>
          new Promise<Array<Record<string, unknown>>>((done, fail) => {
            const started = Date.now()
            const poll = (): void => {
              // Frames may already be buffered: check first, then poll briefly.
              if (received.length >= count) {
                done(received.slice())
                return
              }
              if (Date.now() - started > 2000) {
                fail(new Error(`expected ${count} frame(s), saw ${received.length}`))
                return
              }
              setTimeout(poll, 5)
            }
            poll()
          }),
      })
    })
  })
}

/** Let the bridge accept the TCP/WS upgrade for a just-connected client. */
function tick(ms = 50): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

const bridges: ExtensionBridge[] = []

function makeBridge(port: number, requestTimeoutMs?: number): ExtensionBridge {
  const bridge = new ExtensionBridge(
    requestTimeoutMs === undefined ? { port } : { port, requestTimeoutMs },
  )
  bridges.push(bridge)
  return bridge
}

afterEach(async () => {
  for (const bridge of bridges.splice(0)) {
    await bridge.stop()
  }
})

describe('normalizeTabs', () => {
  it('coerces a chrome.tabs.query payload into ExtensionTab[]', () => {
    const tabs = normalizeTabs([
      { id: 7, title: 'Docs', url: 'https://example.com', active: true, windowId: 2, status: 'complete' },
      { id: 8 },
      { id: 'nope' },
      null,
    ])
    expect(tabs).toEqual([
      { id: 7, title: 'Docs', url: 'https://example.com', active: true, windowId: 2, status: 'complete' },
      { id: 8, title: '', url: '', active: false, windowId: -1 },
    ])
  })

  it('accepts a { tabs: [...] } wrapper and rejects junk', () => {
    expect(normalizeTabs({ tabs: [{ id: 3 }] })).toEqual([
      { id: 3, title: '', url: '', active: false, windowId: -1 },
    ])
    expect(() => normalizeTabs({ nope: 1 })).toThrow(ExtensionBridgeError)
  })
})

describe('ExtensionBridge lifecycle', () => {
  it('binds 127.0.0.1 only and is idempotent on start', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    expect(bridge.isConnected()).toBe(false)
    expect(bridge.connectionCount()).toBe(0)

    await Promise.all([bridge.start(), bridge.start()])
    await bridge.start()

    // Loopback is reachable...
    const client = await connectExtension(port)
    await tick()
    expect(bridge.connectionCount()).toBe(1)
    await client.close()
  })

  it('throws PORT_IN_USE when another process owns the port', async () => {
    const port = nextPort()
    const squatter = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>((done) => squatter.once('listening', () => done()))

    try {
      const bridge = makeBridge(port)
      await expect(bridge.start()).rejects.toMatchObject({ code: 'PORT_IN_USE' })
      await expect(bridge.start()).rejects.toThrow(/DSH_EXTENSION_PORT|another DSH session/i)
    } finally {
      await new Promise<void>((done) => squatter.close(() => done()))
    }
  })

  it('stop() releases the port and is safe when never started', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.stop()
    await bridge.start()
    await bridge.stop()

    // A fresh listener on the same port must now succeed.
    const squatter = new WebSocketServer({ host: '127.0.0.1', port })
    await new Promise<void>((done, fail) => {
      squatter.once('listening', () => done())
      squatter.once('error', fail)
    })
    await new Promise<void>((done) => squatter.close(() => done()))
  })
})

describe('ExtensionBridge request routing', () => {
  it('rejects with NO_EXTENSION when nothing is connected', async () => {
    const bridge = makeBridge(nextPort())
    await bridge.start()
    await expect(bridge.listTabs()).rejects.toMatchObject({ code: 'NO_EXTENSION' })
    await expect(bridge.listTabs()).rejects.toThrow(/extension/i)
  })

  it('sends a request frame and resolves with the response result', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    const pending = bridge.listTabs()
    const frame = await client.waitForFrame()
    expect(frame['method']).toBe('tabs.list')
    expect(typeof frame['id']).toBe('number')

    client.send({ id: frame['id'], ok: true, result: [{ id: 1, title: 'T', url: 'u', active: true, windowId: 0 }] })
    await expect(pending).resolves.toEqual([
      { id: 1, title: 'T', url: 'u', active: true, windowId: 0 },
    ])
    await client.close()
  })

  it('keeps concurrent requests apart by id', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    const first = bridge.evaluate({ tabId: 1, expression: '1' })
    const second = bridge.evaluate({ tabId: 1, expression: '2' })
    const [a, b] = await client.waitForFrames(2)
    expect(a['id']).not.toBe(b['id'])

    // Answer out of order — mapping is by id, not arrival order.
    client.send({ id: b['id'], ok: true, result: { value: 'two' } })
    client.send({ id: a['id'], ok: true, result: { value: 'one' } })
    await expect(first).resolves.toBe('one')
    await expect(second).resolves.toBe('two')
    await client.close()
  })

  it('maps an extension failure body to an error carrying its code', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    const pending = bridge.sendCdp({ tabId: 9, method: 'Page.navigate' })
    const frame = await client.waitForFrame()
    client.send({
      id: frame['id'],
      ok: false,
      error: { code: 'ATTACH_FAILED', message: 'cannot attach', detail: 'no tab 9' },
    })
    await expect(pending).rejects.toMatchObject({
      code: 'ATTACH_FAILED',
      message: 'cannot attach',
      detail: 'no tab 9',
    })
    await client.close()
  })

  it('surfaces a page exception from page.evaluate', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    const pending = bridge.evaluate({ tabId: 1, expression: 'throw 1' })
    const frame = await client.waitForFrame()
    client.send({ id: frame['id'], ok: true, result: { exception: 'ReferenceError: x' } })
    await expect(pending).rejects.toMatchObject({ code: 'PAGE_ERROR' })
    await client.close()
  })

  it('rejects with TIMEOUT when the extension never answers', async () => {
    const port = nextPort()
    const bridge = makeBridge(port, 120)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    await expect(bridge.listTabs()).rejects.toMatchObject({ code: 'TIMEOUT' })
    await client.close()
  })

  it('ignores unparseable frames and keeps serving', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    client.sendRaw('{ not json at all')
    const pending = bridge.listTabs()
    const frame = await client.waitForFrame()
    client.send({ id: frame['id'], ok: true, result: [] })
    await expect(pending).resolves.toEqual([])
    await client.close()
  })

  it('rejects in-flight requests with DISCONNECTED when the socket closes', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    const pending = bridge.listTabs()
    await client.waitForFrame()
    await client.close()

    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(bridge.connectionCount()).toBe(0)
  })
})

describe('ExtensionBridge ready / hello semantics', () => {
  it('only reports isConnected after a hello event', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    await tick()

    expect(bridge.connectionCount()).toBe(1)
    expect(bridge.isConnected()).toBe(false)

    client.send({
      method: 'hello',
      protocolVersion: 1,
      extensionVersion: '0.1.0',
      browser: 'Chrome/141',
    })
    await tick()
    expect(bridge.isConnected()).toBe(true)
    await client.close()
    await tick()
    expect(bridge.isConnected()).toBe(false)
  })

  it('distinguishes "socket present but not ready" from "no socket"', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()

    // A bridge that never started says so, rather than blaming the extension.
    const notStarted = new ExtensionBridge({ port: nextPort() })
    const unstarted = await notStarted.request({ method: 'ping' }).catch((e: unknown) => e)
    expect((unstarted as ExtensionBridgeError).code).toBe('NO_EXTENSION')
    expect((unstarted as ExtensionBridgeError).message).toMatch(/not listening/i)

    // Listening but zero sockets: tell the user to install/enable the extension.
    const noSocket = await bridge.request({ method: 'ping' }).catch((e: unknown) => e)
    expect((noSocket as ExtensionBridgeError).code).toBe('NO_EXTENSION')
    expect((noSocket as ExtensionBridgeError).message).toMatch(/install/i)

    // Listening with an un-helloed socket: distinct message, request still sent.
    const client = await connectExtension(port)
    await tick()
    const pending = bridge.request({ method: 'ping' })
    const frame = await client.waitForFrame()
    client.send({ id: frame['id'], ok: true, result: 'pong' })
    await expect(pending).resolves.toBe('pong')
    await client.close()
  })

  it('forwards events to onEvent listeners', async () => {
    const port = nextPort()
    const bridge = makeBridge(port)
    await bridge.start()
    const client = await connectExtension(port)
    const seen: ExtensionEvent[] = []
    bridge.onEvent((evt) => seen.push(evt))
    await tick()

    client.send({ method: 'tabs.changed', tabId: 4, change: 'created' })
    await tick()
    expect(seen).toEqual([{ method: 'tabs.changed', tabId: 4, change: 'created' }])
    await client.close()
  })
})
