/**
 * A FAKE browser-extension peer for the extension transport tests.
 *
 * Why a real socket instead of a mock: src/extension/bridge.ts is a
 * WebSocket SERVER (`ws`), and everything worth testing lives in the socket
 * layer — id allocation, frame shape, pending-map routing, timeouts, and the
 * close path. Mocking `ws` would test the mock. So this helper dials a REAL
 * `ws://127.0.0.1:PORT` connection, exactly like the MV3 service worker does,
 * and lets a test script the far side of the protocol.
 *
 * Deliberately NOT shared with tests/setup.ts: that file fakes the CDP
 * transport (part C), this one fakes the extension transport (part B). Keeping
 * them in separate modules also keeps this file free of any import from
 * src/**, so it can be used before the bridge module exists (red-first).
 *
 * The helper only knows the shapes documented in src/extension/protocol.ts:
 *   hello   : { method: 'hello', protocolVersion, extensionVersion, browser }
 *   request : { id: <number>, method: <string>, params?: {...} }
 *   response: { id: <number>, ok: true, result } | { id, ok: false, error }
 */

import WebSocket, { WebSocketServer } from 'ws'

/** One frame the bridge pushed to this fake extension. */
export type InboundFrame = Record<string, unknown>

/** Answer one request frame; return the `result` payload (or throw to fail it). */
export type RequestHandler = (
  frame: InboundFrame,
  fake: FakeExtension,
) => unknown | Promise<unknown>

export interface FakeExtensionOptions {
  /**
   * Send the `hello` event immediately after the socket opens (default true).
   * Set false to exercise the "socket present but not ready" branch.
   */
  hello?: boolean
  /** Override the protocol version announced in `hello`. */
  protocolVersion?: number
}

/**
 * A connected fake extension.
 *
 * Construct it with {@link FakeExtension.connect} — the constructor is private
 * so a test can never hold a half-open socket.
 */
export class FakeExtension {
  /** Every frame the bridge sent, in arrival order (requests AND events). */
  readonly received: InboundFrame[] = []

  private readonly socket: WebSocket
  private readonly handlers: RequestHandler[] = []
  private readonly frameWaiters: Array<{
    match: (frame: InboundFrame) => boolean
    resolve: (frame: InboundFrame) => void
  }> = []
  /** Ids this fake answered (used by tests to assert routing). */
  readonly answeredIds: number[] = []
  private closed = false

  private constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data: WebSocket.RawData) => {
      this.onFrame(data)
    })
    socket.on('error', () => {
      // Errors surface as 'close'; tests tear sockets down abruptly on purpose.
    })
    socket.on('close', () => {
      this.closed = true
    })
  }

  /** Dial the bridge and (optionally) complete the handshake. */
  static async connect(port: number, options: FakeExtensionOptions = {}): Promise<FakeExtension> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`)
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', (err: Error) => reject(err))
    })
    const fake = new FakeExtension(socket)
    if (options.hello !== false) {
      fake.sendHello(options.protocolVersion)
      // Give the bridge a turn of the loop to process the hello frame, so a
      // test can assert isConnected() right after connect() returns.
      await tick(10)
    }
    return fake
  }

  /** True once the socket is closed (local or remote). */
  get isClosed(): boolean {
    return this.closed || this.socket.readyState === WebSocket.CLOSED
  }

  /** Send the `hello` handshake event. */
  sendHello(protocolVersion = 1): void {
    this.sendFrame({
      method: 'hello',
      protocolVersion,
      extensionVersion: '0.0.0-test',
      browser: 'Chrome/0.0-test',
    })
  }

  /** Send any event the protocol defines (e.g. `tabs.changed`). */
  sendEvent(event: Record<string, unknown>): void {
    this.sendFrame(event)
  }

  /** Send a raw frame verbatim (malformed-input tests). */
  sendRaw(text: string): void {
    this.socket.send(text)
  }

  /** Send any JSON frame (must be OPEN; throws otherwise). */
  sendFrame(frame: unknown): void {
    this.socket.send(JSON.stringify(frame))
  }

  /**
   * Register an automatic responder for inbound request frames.
   * Handlers are consulted in registration order; the first non-undefined
   * return wins. Register one per test for predictable behaviour.
   */
  onRequest(handler: RequestHandler): void {
    this.handlers.push(handler)
  }

  /** Convenience: answer every request with one fixed payload. */
  answerAlways(result: unknown): void {
    this.onRequest(() => result)
  }

  /** Answer one request frame with a JSON-RPC-ish response. */
  respond(id: number, result: unknown): void {
    this.answeredIds.push(id)
    this.sendFrame({ id, ok: true, result })
  }

  /** Answer one request frame with a structured failure. */
  respondError(id: number, code: string, message: string): void {
    this.answeredIds.push(id)
    this.sendFrame({ id, ok: false, error: { code, message } })
  }

  /** All request frames the bridge sent (frames carrying a numeric id). */
  requests(): InboundFrame[] {
    return this.received.filter((frame) => typeof frame['id'] === 'number')
  }

  /** The most recent request frame, or undefined. */
  lastRequest(): InboundFrame | undefined {
    return this.requests().at(-1)
  }

  /**
   * Resolve the first request frame matching `match` — including one that
   * already arrived. Rejects after `timeoutMs` so a hung test fails loudly
   * instead of hanging jest.
   */
  nextRequest(
    match: (frame: InboundFrame) => boolean = () => true,
    timeoutMs = 2000,
  ): Promise<InboundFrame> {
    const existing = this.received.find(
      (frame) => typeof frame['id'] === 'number' && match(frame),
    )
    if (existing !== undefined) return Promise.resolve(existing)
    return new Promise<InboundFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`fake extension: no request frame arrived within ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      this.frameWaiters.push({
        match: (frame) => typeof frame['id'] === 'number' && match(frame),
        resolve: (frame) => {
          clearTimeout(timer)
          resolve(frame)
        },
      })
    })
  }

  /** Resolve the first request whose `method` equals `method`. */
  nextRequestFor(method: string, timeoutMs = 2000): Promise<InboundFrame> {
    return this.nextRequest((frame) => frame['method'] === method, timeoutMs)
  }

  /** Close the socket normally and wait for the close handshake to finish. */
  async close(): Promise<void> {
    if (this.closed || this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolve) => {
      this.socket.once('close', () => resolve())
      this.socket.close()
    })
  }

  /**
   * Kill the socket WITHOUT a close handshake — the "service worker went
   * idle / browser crashed" case the bridge must survive.
   */
  terminate(): void {
    this.socket.terminate()
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private onFrame(data: WebSocket.RawData): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString('utf8'))
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    const frame = parsed as InboundFrame
    this.received.push(frame)

    for (let i = this.frameWaiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.frameWaiters[i]
      if (waiter !== undefined && waiter.match(frame)) {
        this.frameWaiters.splice(i, 1)
        waiter.resolve(frame)
      }
    }

    if (typeof frame['id'] !== 'number') return // events are not answered
    void this.dispatch(frame)
  }

  private async dispatch(frame: InboundFrame): Promise<void> {
    for (const handler of this.handlers) {
      let value: unknown
      try {
        value = await handler(frame, this)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.respondError(Number(frame['id']), 'HANDLER_ERROR', message)
        return
      }
      if (value !== undefined) {
        this.respond(Number(frame['id']), value)
        return
      }
    }
    // No handler claimed it: deliberately silent, which is how the timeout
    // test gets an unanswered request.
  }
}

/** Let pending socket I/O settle (one macrotask turn). */
export function tick(ms = 25): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * Bind 127.0.0.1 on one of `ports`, returning the port that actually bound.
 *
 * PROBE STRATEGY (documented in the test file too): ExtensionBridge's API has
 * no "port 0 = pick anything" mode — `new ExtensionBridge({ port })` validates
 * 1..65535 at construction time and there is no way to read back an
 * OS-assigned port. So the tests probe a small deterministic range and take
 * the first port that is free; if every candidate is taken the caller is
 * expected to skip (see `acquireFreePort` returning null).
 *
 * The probe closes its listener and the caller then binds the real bridge;
 * there is a theoretical race between probe and bind, but on loopback with a
 * per-test range it has not been observed and PORT_IN_USE itself is asserted
 * separately (test 10).
 */
export async function probeFreePort(
  candidates: Iterable<number>,
): Promise<number | null> {
  for (const port of candidates) {
    const free = await canBind(port)
    if (free) return port
  }
  return null
}

/** True when 127.0.0.1:port can be bound right now. */
export function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ host: '127.0.0.1', port })
    const finish = (ok: boolean): void => {
      server.removeAllListeners()
      try {
        server.close()
      } catch {
        // never bound
      }
      resolve(ok)
    }
    server.once('listening', () => finish(true))
    server.once('error', () => finish(false))
  })
}

/**
 * Like {@link probeFreePort}, but waits up to `settleMs` for the port to
 * become free.
 *
 * Needed because jest keeps a FULLY CLOSED server's port in TIME_WAIT on
 * Windows for a while: a previous bridge that just called stop() makes the
 * probe report EADDRINUSE even though nothing is listening. Retrying with a
 * short delay distinguishes "somebody owns it" (stays busy) from "recently
 * released" (frees up within a few hundred ms).
 */
export async function waitForFreePort(
  candidates: Iterable<number>,
  settleMs = 1500,
): Promise<number | null> {
  const deadline = Date.now() + settleMs
  for (;;) {
    const port = await probeFreePort(candidates)
    if (port !== null) return port
    if (Date.now() >= deadline) return null
    await tick(100)
  }
}

/**
 * A deterministic run of candidate ports: 18790 + seed, stepping by 1.
 * The task brief suggested `18790 + random*100`; a pid-seeded deterministic
 * sequence is used instead so repeated runs reuse a small, greppable set and
 * parallel jest workers (different pids) do not all pick the same number.
 */
export function candidatePorts(count = 16, base = 18790): number[] {
  const seed = (process.pid * 37) % 100
  const ports: number[] = []
  for (let i = 0; i < count; i += 1) {
    ports.push(base + ((seed + i) % 100))
  }
  return ports
}
