/**
 * Host side of the extension transport.
 *
 * The plugin runs a loopback WebSocket SERVER; the browser extension dials
 * OUT to it (`chrome.debugger` is Chrome's official alternate CDP transport,
 * so an extension can drive the browser a user already has open — including
 * the default profile, which Chrome 136+ refuses to expose over a debug
 * port). See ./protocol.ts for the wire contract.
 *
 *   DSH host (Node)                       Browser
 *   ┌──────────────────────┐             ┌────────────────────────────┐
 *   │ ExtensionBridge      │◀── WS ──────│ MV3 service worker         │
 *   │ ws://127.0.0.1:PORT  │  (dials out)│ chrome.debugger.attach(...)│
 *   └──────────────────────┘             └────────────────────────────┘
 *
 * Design notes
 * ------------
 * - Binds 127.0.0.1 ONLY. This is a local control channel able to drive the
 *   user's real browser; exposing it on 0.0.0.0 would be a remote-automation
 *   hole in the user's network.
 * - Every socket is tracked with its own ready flag. `hello` marks it ready.
 *   Requests are NOT blocked until `hello` (the extension may still be
 *   mid-handshake), but the "not connected" message distinguishes "no socket
 *   at all" from "socket present but not ready" so the user gets the right
 *   next step.
 * - Requests are routed to the FIRST READY socket (insertion order), falling
 *   back to the most recent socket when none has completed `hello`. Normally
 *   there is exactly one; extra sockets (stale service worker, second
 *   profile) are accepted and tolerated.
 * - In-flight requests live in one Map keyed by the numeric id we allocate,
 *   so concurrent requests are safe: unique ids, unique timers.
 * - Socket close / bridge stop rejects every in-flight request with
 *   'DISCONNECTED' and clears all timers (no unhandled rejections, no leaks).
 * - All diagnostics go to stderr — NEVER stdout. This module runs inside a
 *   host process whose stdout may be a protocol channel (DSH plugin /
 *   stdio MCP transport).
 */
import { WebSocket, WebSocketServer } from 'ws';
import { EXTENSION_DEFAULT_PORT, EXTENSION_PROTOCOL_VERSION, EXTENSION_REQUEST_TIMEOUT_MS, isEvent, isResponse, } from './protocol.js';
/** Log prefix for every diagnostic this module emits. */
const LOG_PREFIX = '[extension/bridge]';
/**
 * Error type for every failure surfaced by {@link ExtensionBridge}.
 *
 * `code` is a stable machine code (see {@link ExtensionBridgeErrorCode}) so
 * the tools layer can map it onto user-facing text without string matching.
 * `detail` carries extra diagnostics and is never an instruction.
 */
export class ExtensionBridgeError extends Error {
    code;
    detail;
    constructor(message, code, detail) {
        super(message);
        this.code = code;
        this.detail = detail;
        this.name = 'ExtensionBridgeError';
    }
}
/** Narrow an unknown parsed frame to a JSON object (not null, not array). */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Write one diagnostic line to stderr. Never stdout. */
function log(message) {
    process.stderr.write(`${LOG_PREFIX} ${message}\n`);
}
/** Render an unknown thrown value for a log line. */
function describeError(err) {
    return err instanceof Error ? err.message : String(err);
}
/** Close code used when we shut a socket down ourselves (1000 = normal). */
const WS_CLOSE_NORMAL = 1000;
export class ExtensionBridge {
    /** Port the server binds (and the extension dials). */
    port;
    /** Per-request timeout budget in ms. */
    requestTimeoutMs;
    /** Protocol version this host speaks (shipped for the tools/diagnostic layer). */
    protocolVersion = EXTENSION_PROTOCOL_VERSION;
    server = null;
    starting = null;
    stopping = null;
    peers = [];
    peerSeq = 0;
    pending = new Map();
    listeners = [];
    nextId = 1;
    constructor(options = {}) {
        const port = options.port ?? EXTENSION_DEFAULT_PORT;
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new ExtensionBridgeError(`Invalid extension bridge port: ${String(port)}. Expected an integer in 1..65535.`, 'BIND_FAILED');
        }
        const timeout = options.requestTimeoutMs ?? EXTENSION_REQUEST_TIMEOUT_MS;
        if (!Number.isFinite(timeout) || timeout <= 0) {
            throw new ExtensionBridgeError(`Invalid extension request timeout: ${String(timeout)}. Expected a positive number of milliseconds.`, 'TIMEOUT');
        }
        this.port = port;
        this.requestTimeoutMs = timeout;
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    /**
     * Start listening on 127.0.0.1:PORT. Idempotent: concurrent or repeated
     * calls share one promise and resolve once the server is bound.
     *
     * @throws ExtensionBridgeError `PORT_IN_USE` when another process owns the
     *   port, `BIND_FAILED` for any other bind failure.
     */
    start() {
        if (this.server !== null)
            return Promise.resolve();
        if (this.starting !== null)
            return this.starting;
        const attempt = new Promise((resolve, reject) => {
            const server = new WebSocketServer({ host: '127.0.0.1', port: this.port });
            let settled = false;
            const onListening = () => {
                if (settled)
                    return;
                settled = true;
                server.removeListener('error', onError);
                this.server = server;
                log(`listening on ws://127.0.0.1:${this.port} (waiting for the extension to connect)`);
                resolve();
            };
            const onError = (err) => {
                if (settled) {
                    // Post-listen runtime error (e.g. an odd upgrade) — never throw from
                    // an event handler; log and keep serving.
                    log(`server error: ${describeError(err)}`);
                    return;
                }
                settled = true;
                server.removeListener('listening', onListening);
                // `ws` closes the underlying listener when it fails to bind.
                try {
                    server.close();
                }
                catch {
                    // Already closed / never opened — nothing to release.
                }
                try {
                    this.server = null;
                }
                catch {
                    // unreachable, kept for symmetry
                }
                const code = err.code;
                if (code === 'EADDRINUSE') {
                    reject(new ExtensionBridgeError(`Port ${this.port} is already in use, so the browser extension cannot reach this ` +
                        `DSH session. Another DSH session (or another program) is probably listening ` +
                        `there. Either quit that session, or start this one on a different port by ` +
                        `setting DSH_EXTENSION_PORT to a free port (e.g. ${this.port + 1}) and pointing ` +
                        `the extension at it.`, 'PORT_IN_USE', describeError(err)));
                    return;
                }
                reject(new ExtensionBridgeError(`Could not start the extension bridge on 127.0.0.1:${this.port}: ${describeError(err)}. ` +
                    `Set DSH_EXTENSION_PORT to a free port if this one is unavailable.`, 'BIND_FAILED', describeError(err)));
            };
            server.once('listening', onListening);
            server.once('error', onError);
            server.on('error', (err) => {
                // Runtime errors after binding must not crash the host process.
                if (settled)
                    log(`server error: ${describeError(err)}`);
            });
            server.on('connection', (socket) => {
                if (settled)
                    this.adoptSocket(socket);
            });
        });
        this.starting = attempt.finally(() => {
            this.starting = null;
        });
        return this.starting;
    }
    /**
     * Stop listening and close every extension socket. Idempotent and safe to
     * call when never started. All in-flight requests are rejected with
     * 'DISCONNECTED'.
     */
    stop() {
        if (this.stopping !== null)
            return this.stopping;
        this.rejectAllPending(() => new ExtensionBridgeError('The extension bridge was stopped before the extension answered.', 'DISCONNECTED'));
        const peers = this.peers.slice();
        this.peers.length = 0;
        for (const peer of peers) {
            this.closePeer(peer, 'The DSH extension bridge is shutting down.');
        }
        const server = this.server;
        this.server = null;
        if (server === null)
            return Promise.resolve();
        this.stopping = new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                log('stopped listening');
                resolve();
            };
            try {
                server.close(() => finish());
            }
            catch (err) {
                log(`error while closing the server: ${describeError(err)}`);
                finish();
                return;
            }
            // Safety net: a half-open socket can keep `close` from firing its
            // callback. Drop clients hard, then resolve on the next turn.
            for (const client of server.clients) {
                try {
                    client.terminate();
                }
                catch {
                    // Already gone.
                }
            }
            setTimeout(finish, 1000).unref();
        }).finally(() => {
            this.stopping = null;
        });
        return this.stopping;
    }
    // -------------------------------------------------------------------------
    // Connection state
    // -------------------------------------------------------------------------
    /**
     * True when at least one extension socket has completed the `hello`
     * handshake. A socket that connected but never said hello does NOT count.
     */
    isConnected() {
        return this.peers.some((peer) => peer.ready);
    }
    /** Number of connected extension sockets (accepted ones; normally 0 or 1). */
    connectionCount() {
        return this.peers.length;
    }
    /**
     * Register a listener for extension events (`hello`, `tabs.changed`,
     * `debugger.detached`). Listeners are append-only for the lifetime of the
     * bridge; a throwing listener is logged and cannot affect the others.
     */
    onEvent(cb) {
        this.listeners.push(cb);
    }
    // -------------------------------------------------------------------------
    // Requests
    // -------------------------------------------------------------------------
    /**
     * Send one request and await the extension's response payload.
     *
     * @param req - Request without `id` (allocated here, monotonic per bridge).
     *   Typed as {@link ExtensionRequestPayload}: a distributing `Omit` so each
     *   union member keeps its own `params` (a plain `Omit<ExtensionRequest, 'id'>`
     *   collapses to the common fields and loses `params`).
     * @returns The `result` field of the extension's success response.
     * @throws ExtensionBridgeError with code 'NO_EXTENSION' (nothing can receive
     *   it), 'TIMEOUT', 'DISCONNECTED', 'SEND_FAILED', or — mapped from a
     *   structured extension failure — the extension's own error code.
     */
    request(req) {
        const peer = this.selectPeer();
        if (peer === null) {
            return Promise.reject(this.noExtensionError());
        }
        const id = this.nextId;
        this.nextId = this.nextId >= Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
        const frame = { ...req, id };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new ExtensionBridgeError(`The browser extension did not answer '${frame.method}' within ` +
                    `${this.requestTimeoutMs}ms. Check that the extension is still loaded ` +
                    `(chrome://extensions) and that the target tab is still open.`, 'TIMEOUT'));
            }, this.requestTimeoutMs);
            // Do not keep the host process alive just for a pending timer.
            timer.unref();
            this.pending.set(id, { id, method: frame.method, resolve, reject, timer, peer });
            try {
                peer.socket.send(JSON.stringify(frame));
            }
            catch (err) {
                this.pending.delete(id);
                clearTimeout(timer);
                reject(new ExtensionBridgeError(`Could not send '${frame.method}' to the extension: ${describeError(err)}`, 'SEND_FAILED', describeError(err)));
            }
        });
    }
    /**
     * List the user's browser tabs.
     *
     * Note: this returns whatever the extension sends; the tool layer is
     * expected to validate the shape (see `normalizeTabs` for the defensive
     * version the bridge applies to its own convenience wrapper).
     */
    async rawListTabs() {
        return this.request({ method: 'tabs.list' });
    }
    /** List the user's browser tabs (`chrome.tabs.query({})` shape). */
    async listTabs() {
        const result = await this.request({ method: 'tabs.list' });
        return normalizeTabs(result);
    }
    /**
     * Evaluate JavaScript in a tab.
     *
     * Unwraps the extension's `EvaluateResult` envelope: returns its `value`
     * when present, and throws ExtensionBridgeError('PAGE_ERROR') when the page
     * threw (the exception text is the message).
     */
    async evaluate(params) {
        const result = await this.request({ method: 'page.evaluate', params });
        if (!isRecord(result))
            return result;
        if (typeof result['exception'] === 'string' && result['exception'].length > 0) {
            throw new ExtensionBridgeError(`The page threw while evaluating the expression: ${result['exception']}`, 'PAGE_ERROR', result['exception']);
        }
        return 'value' in result ? result['value'] : result;
    }
    /** Capture a page snapshot (simplified HTML, or visible text when textOnly). */
    async snapshot(params) {
        const result = await this.request({ method: 'page.snapshot', params });
        if (!isRecord(result) || typeof result['content'] !== 'string') {
            throw new ExtensionBridgeError('The extension returned a malformed page.snapshot result.', 'PROTOCOL_ERROR', safeJson(result));
        }
        return {
            content: result['content'],
            truncated: result['truncated'] === true,
            title: typeof result['title'] === 'string' ? result['title'] : '',
            url: typeof result['url'] === 'string' ? result['url'] : '',
        };
    }
    /** Send a raw CDP command to a tab's debugger session. */
    async sendCdp(params) {
        return this.request({ method: 'cdp.send', params });
    }
    /** Read cookies (the tab's origin, or every domain when `all`). */
    async getCookies(params) {
        const result = await this.request({ method: 'cookies.get', params });
        if (Array.isArray(result))
            return result;
        if (isRecord(result) && Array.isArray(result['cookies'])) {
            return result['cookies'];
        }
        return [];
    }
    // -------------------------------------------------------------------------
    // Socket plumbing
    // -------------------------------------------------------------------------
    /**
     * Pick where a request goes: the first socket that completed `hello`, else
     * the most recently accepted socket (it may still be mid-handshake).
     * Returns null when nothing is connected at all.
     */
    selectPeer() {
        for (const peer of this.peers) {
            if (peer.ready && peer.socket.readyState === WebSocket.OPEN)
                return peer;
        }
        for (let i = this.peers.length - 1; i >= 0; i -= 1) {
            const peer = this.peers[i];
            if (peer !== undefined && peer.socket.readyState === WebSocket.OPEN)
                return peer;
        }
        return null;
    }
    /** Error raised when `request()` has no socket to talk to. */
    noExtensionError() {
        if (this.peers.length > 0) {
            return new ExtensionBridgeError('The browser extension is connected but has not finished its handshake yet ' +
                '(no "hello" received). Wait a moment and retry; if this persists, reload the ' +
                'extension on chrome://extensions so its service worker restarts.', 'NO_EXTENSION', `sockets=${this.peers.length} ready=0`);
        }
        if (this.server === null) {
            return new ExtensionBridgeError('The extension bridge is not listening, so no browser extension can connect. ' +
                'Start the DSH browser bridge (the plugin starts it automatically) and retry.', 'NO_EXTENSION', 'server not started');
        }
        return new ExtensionBridgeError(`No browser extension is connected on ws://127.0.0.1:${this.port}. ` +
            'Install the DSH browser bridge extension in Chrome/Edge and OPEN it (it must be ' +
            'enabled on chrome://extensions); an already-installed but disabled extension is the ' +
            'most common cause. The extension reconnects by itself once it is enabled.', 'NO_EXTENSION', `listening on 127.0.0.1:${this.port}, connections=0`);
    }
    /** Track a freshly accepted socket and wire its handlers. */
    adoptSocket(socket) {
        this.peerSeq += 1;
        const peer = { seq: this.peerSeq, socket, ready: false };
        this.peers.push(peer);
        log(`extension connected (${this.peers.length} socket(s), awaiting hello)`);
        socket.on('message', (data, isBinary) => {
            this.handleFrame(peer, data, isBinary);
        });
        socket.on('close', (code, reason) => {
            this.removePeer(peer, `socket closed (code=${code}, reason=${reason.toString() || 'none'})`);
        });
        socket.on('error', (err) => {
            this.removePeer(peer, `socket error: ${describeError(err)}`);
        });
    }
    /** Parse and dispatch one inbound frame. Unparseable frames are logged and ignored. */
    handleFrame(peer, data, isBinary) {
        if (isBinary) {
            log('ignoring binary frame from the extension (protocol is JSON text)');
            return;
        }
        const text = toText(data);
        if (text === null) {
            log('ignoring frame with an undecodable payload');
            return;
        }
        let parsed;
        try {
            parsed = JSON.parse(text);
        }
        catch (err) {
            log(`ignoring unparseable frame (${describeError(err)}): ${truncate(text, 200)}`);
            return;
        }
        if (isResponse(parsed)) {
            this.settle(parsed);
            return;
        }
        if (isEvent(parsed)) {
            this.dispatchEvent(peer, parsed);
            return;
        }
        // Legacy request frames: the transport is host->extension only, so a
        // request arriving here is a protocol violation, not something to answer.
        log(`ignoring unrecognised frame: ${truncate(text, 200)}`);
    }
    /** Resolve or reject the pending entry that matches a response frame. */
    settle(response) {
        const entry = this.pending.get(response.id);
        if (entry === undefined) {
            log(`ignoring response for unknown request id ${response.id} (already settled or stale)`);
            return;
        }
        this.pending.delete(response.id);
        clearTimeout(entry.timer);
        if (response.ok) {
            entry.resolve(response.result);
            return;
        }
        const body = response.error;
        const code = typeof body?.code === 'string' && body.code.length > 0 ? body.code : 'EXTENSION_ERROR';
        const message = typeof body?.message === 'string' && body.message.length > 0
            ? body.message
            : `The extension rejected '${entry.method}'.`;
        entry.reject(new ExtensionBridgeError(message, code, typeof body?.detail === 'string' ? body.detail : undefined));
    }
    /** Fan an event out to listeners; `hello` also promotes the socket to ready. */
    dispatchEvent(peer, evt) {
        if (evt.method === 'hello') {
            if (!peer.ready) {
                peer.ready = true;
                peer.extensionVersion = typeof evt.extensionVersion === 'string' ? evt.extensionVersion : undefined;
                peer.browser = typeof evt.browser === 'string' ? evt.browser : undefined;
                log(`extension ready: version=${peer.extensionVersion ?? 'unknown'} ` +
                    `browser=${peer.browser ?? 'unknown'} protocol=${String(evt.protocolVersion)}`);
                if (evt.protocolVersion !== EXTENSION_PROTOCOL_VERSION) {
                    log(`WARNING: extension speaks protocol ${String(evt.protocolVersion)} but this host ` +
                        `speaks ${EXTENSION_PROTOCOL_VERSION}; update the extension or the plugin.`);
                }
            }
        }
        else if (evt.method === 'debugger.detached') {
            log(`debugger detached from tab ${evt.tabId}: ${evt.reason}`);
        }
        for (const listener of this.listeners.slice()) {
            try {
                listener(evt);
            }
            catch (err) {
                log(`event listener threw for '${evt.method}': ${describeError(err)}`);
            }
        }
    }
    /**
     * Drop a peer and reject anything that was in flight on it. Requests sent to
     * other (still open) sockets are left alone.
     */
    removePeer(peer, reason) {
        const index = this.peers.indexOf(peer);
        if (index === -1)
            return;
        this.peers.splice(index, 1);
        log(`extension disconnected: ${reason} (${this.peers.length} socket(s) left)`);
        for (const [id, entry] of Array.from(this.pending.entries())) {
            if (entry.peer !== peer)
                continue;
            this.pending.delete(id);
            clearTimeout(entry.timer);
            entry.reject(new ExtensionBridgeError(`The browser extension disconnected before answering '${entry.method}'. ` +
                'Re-open the extension (its service worker may have gone idle) and retry.', 'DISCONNECTED', reason));
        }
    }
    /** Reject every in-flight request with a fresh error from `make`. */
    rejectAllPending(make) {
        for (const [, entry] of Array.from(this.pending.entries())) {
            this.pending.delete(entry.id);
            clearTimeout(entry.timer);
            entry.reject(make(entry));
        }
    }
    /** Best-effort close of one socket; terminates if it does not go quietly. */
    closePeer(peer, reason) {
        try {
            peer.socket.close(WS_CLOSE_NORMAL, reason);
        }
        catch (err) {
            log(`error while closing a socket: ${describeError(err)}`);
            return;
        }
        // A wedged half-open socket would otherwise keep the server alive.
        const socket = peer.socket;
        const timer = setTimeout(() => {
            try {
                socket.terminate();
            }
            catch {
                // Already gone.
            }
        }, 250);
        timer.unref();
    }
}
// ---------------------------------------------------------------------------
// Narrowing helpers
// ---------------------------------------------------------------------------
/** Decode a ws RawData payload to UTF-8 text, or null when it is not text. */
function toText(data) {
    if (typeof data === 'string')
        return data;
    if (Buffer.isBuffer(data))
        return data.toString('utf8');
    if (Array.isArray(data))
        return Buffer.concat(data).toString('utf8');
    if (data instanceof ArrayBuffer)
        return Buffer.from(data).toString('utf8');
    return null;
}
/** Truncate a diagnostic string for a log line. */
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}
/** JSON.stringify that never throws (for `detail` fields). */
function safeJson(value) {
    try {
        return truncate(JSON.stringify(value) ?? '', 500);
    }
    catch {
        return undefined;
    }
}
/**
 * Coerce a `tabs.list` payload into {@link ExtensionTab}[].
 *
 * The extension is trusted but still on the far side of a socket: missing
 * fields get sane defaults instead of throwing, and entries that are not
 * objects with a numeric id are dropped (they cannot be addressed anyway).
 *
 * Exported because the tools layer may receive tab payloads from elsewhere
 * (e.g. a cached `tabs.changed` event) and should apply the same coercion.
 */
export function normalizeTabs(result) {
    const list = Array.isArray(result)
        ? result
        : isRecord(result) && Array.isArray(result['tabs'])
            ? result['tabs']
            : null;
    if (list === null) {
        throw new ExtensionBridgeError('The extension returned a malformed tabs.list result (expected an array of tabs).', 'PROTOCOL_ERROR', safeJson(result));
    }
    const tabs = [];
    for (const item of list) {
        if (!isRecord(item))
            continue;
        const id = item['id'];
        if (typeof id !== 'number' || !Number.isInteger(id))
            continue;
        const tab = {
            id,
            title: typeof item['title'] === 'string' ? item['title'] : '',
            url: typeof item['url'] === 'string' ? item['url'] : '',
            active: item['active'] === true,
            windowId: typeof item['windowId'] === 'number' ? item['windowId'] : -1,
        };
        if (typeof item['status'] === 'string')
            tab.status = item['status'];
        tabs.push(tab);
    }
    return tabs;
}
//# sourceMappingURL=bridge.js.map