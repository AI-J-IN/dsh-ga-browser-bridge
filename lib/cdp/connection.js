/**
 * CDP WebSocket connection layer.
 *
 * One browser-level WebSocket (from /json/version's webSocketDebuggerUrl) is
 * reused for all communication. We use the FLAT protocol: page-level
 * sessionIds are obtained via Target.setAutoAttach (and/or explicit
 * Target.attachToTarget with flatten:true) and commands are routed by
 * including a top-level `sessionId` field on the JSON-RPC message.
 *
 * Rules this module obeys:
 *  - JSON.stringify/parse only for the wire format.
 *  - NEVER write to stdout (this runs under MCP stdio where stdout IS the
 *    protocol). All diagnostics go to stderr.
 *  - Every WS command has a timeout (default 30000 ms) and rejects with
 *    CdpError on timeout or on a CDP error response.
 *  - Auto-reconnect: an unexpected socket close marks the connection down;
 *    the next send()/ensureOpen() reconnects and re-runs setAutoAttach.
 *  - ensureOpen() can auto-launch Chrome (via launcher.ensureDebugChrome)
 *    when the debug port is closed, unless autoLaunch:false was configured.
 */
import WebSocket from "ws";
import { activateTarget as httpActivateTarget, closeTarget as httpCloseTarget, getVersion, listTargets, newTab, } from "./json.js";
import { CdpHttpError } from "./json.js";
import { DEFAULT_DEBUG_PORT, ensureDebugChrome, envPort, envUserDataDir, isDebugPortOpen, } from "./launcher.js";
/** Default per-command WebSocket timeout (ms). */
const DEFAULT_WS_TIMEOUT_MS = 30000;
/** Poll interval while waiting for the debug port / HTTP endpoint (ms). */
const OPEN_POLL_INTERVAL_MS = 200;
/** Max time spent waiting for the port to open during ensureOpen (ms). */
const OPEN_WAIT_MS = 30000;
/** Diagnostics go to stderr only (stdout is the MCP protocol channel). */
function log(msg) {
    process.stderr.write(`[cdp/connection] ${msg}\n`);
}
/** CDP protocol-level error (command error response, timeout, etc.). */
export class CdpError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = "CdpError";
    }
}
/**
 * A flat-protocol session bound to one target. Commands sent through it are
 * routed with a top-level `sessionId` on the wire; events emitted by the
 * target arrive with that sessionId and are re-dispatched to the session's
 * listeners.
 */
export class TargetSession {
    /** Target id this session is bound to. */
    targetId;
    conn;
    sessionId;
    listeners = [];
    closed = false;
    /** @internal */
    constructor(conn, targetId, sessionId) {
        this.conn = conn;
        this.targetId = targetId;
        this.sessionId = sessionId;
    }
    /**
     * Send a CDP command scoped to this target's session.
     *
     * Works whether the session was discovered via auto-attach or created via
     * explicit Target.attachToTarget(flatten:true): the wire format is the same
     * (top-level sessionId field).
     *
     * @param method - CDP method name, e.g. "Runtime.evaluate".
     * @param params - Command parameters.
     * @param timeoutMs - Per-command timeout (default 30000).
     * @returns The command's `result` object.
     */
    async send(method, params, timeoutMs) {
        if (this.closed) {
            throw new CdpError(`session for target ${this.targetId} is closed`);
        }
        return this.conn.sendWithSession(method, params, this.sessionId, timeoutMs);
    }
    /**
     * Subscribe to events emitted on this target session.
     * @param cb - Callback receiving (method, params).
     */
    onEvent(cb) {
        this.listeners.push(cb);
    }
    /**
     * Close the session (Target.detachFromTarget). The session object becomes
     * unusable afterwards; closing twice is a no-op.
     */
    async close() {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.listeners = [];
        try {
            await this.conn.send("Target.detachFromTarget", { sessionId: this.sessionId });
        }
        catch (err) {
            // Detach failures are non-fatal for the caller (session may already be
            // gone); log to stderr and continue.
            log(`detachFromTarget failed for ${this.targetId}: ${String(err?.message ?? err)}`);
        }
        finally {
            this.conn.forgetSession(this.sessionId);
        }
    }
    /** @internal dispatch an incoming event to this session's listeners. */
    emitEvent(method, params) {
        for (const cb of [...this.listeners]) {
            try {
                cb(method, params);
            }
            catch (err) {
                log(`session event listener error (${method}): ${String(err?.message ?? err)}`);
            }
        }
    }
    /** @internal mark closed without touching the wire (used by connection close). */
    markClosed() {
        this.closed = true;
        this.listeners = [];
    }
    /** @internal */
    get isClosed() {
        return this.closed;
    }
    /** @internal */
    get id() {
        return this.sessionId;
    }
}
/**
 * Browser-level CDP connection over one WebSocket.
 *
 * Lifecycle: construct lazily — the socket is opened on first ensureOpen() or
 * send(). ensureOpen() additionally guarantees a debuggable Chrome exists:
 * it probes the TCP debug port, and when autoLaunch is enabled (default) and
 * the port is closed it launches Chrome (reusing the default profile so
 * login state is preserved) before connecting.
 *
 * Env overrides (README-documented): DSH_BROWSER_PORT applies as the port
 * fallback when neither options.port nor the positional port is given;
 * DSH_BROWSER_USER_DATA_DIR flows into the auto-launch as a custom profile.
 */
export class CdpConnection {
    host;
    port;
    defaultTimeoutMs;
    autoLaunch;
    socket = null;
    opening = null;
    open = false;
    intentionalClose = false;
    nextId = 1;
    pending = new Map();
    connectionListeners = [];
    /** targetId -> sessionId (flat protocol), maintained via auto-attach. */
    sessionIds = new Map();
    /** sessionId -> TargetSession for event routing. */
    sessions = new Map();
    /** HTTP-level tab cache merged into listTabs() results (createTarget lag). */
    cachedTabs = new Map();
    browserWsUrl = null;
    /**
     * @param host - Debug host (e.g. "127.0.0.1").
     * @param port - Debug port (e.g. 9222).
     * @param options - Optional overrides: timeoutMs (per-command WS timeout),
     *   host/port (alternate way to supply host/port), autoLaunch (default
     *   true; when false, ensureOpen() throws CdpError instead of launching
     *   Chrome when the debug port is closed).
     */
    constructor(host, port, options) {
        this.host = options?.host ?? host;
        // Env fallback (README-documented): explicit options.port or positional
        // port win; DSH_BROWSER_PORT applies only when neither is given.
        this.port = options?.port ?? port ?? envPort() ?? DEFAULT_DEBUG_PORT;
        this.defaultTimeoutMs = options?.timeoutMs ?? DEFAULT_WS_TIMEOUT_MS;
        this.autoLaunch = options?.autoLaunch !== false;
    }
    // -------------------------------------------------------------------------
    // Connection lifecycle
    // -------------------------------------------------------------------------
    /**
     * Ensure the browser WebSocket is open, auto-launching Chrome first when
     * needed. Safe to call repeatedly; subsequent calls reuse the connection.
     *
     * State machine:
     *  1. Socket already open -> resolve immediately.
     *  2. A connect attempt is already in flight -> await it.
     *  3. Probe TCP debug port:
     *     - port open  -> connect browser WS.
     *     - port closed, autoLaunch=true  -> ensureDebugChrome(port) (reuses
     *       the default profile for login state; throws LaunchError through
     *       unchanged when Chrome is already running without a debug port),
     *       then connect.
     *     - port closed, autoLaunch=false -> CdpError("debug port closed ...").
     *  4. On success, run Target.setAutoAttach so page targets report
     *     sessionIds for flat-protocol routing.
     *
     * LaunchError (from the launcher) propagates to the caller unchanged.
     */
    async ensureOpen() {
        if (this.open && this.socket) {
            return;
        }
        if (this.opening) {
            await this.opening;
            return;
        }
        const portOpen = await isDebugPortOpen(this.port, this.host);
        if (!portOpen) {
            if (!this.autoLaunch) {
                throw new CdpError(`debug port closed: nothing listening on ${this.host}:${this.port} ` +
                    `(autoLaunch disabled)`);
            }
            log(`debug port ${this.host}:${this.port} closed; launching Chrome`);
            // LaunchError propagates to the caller unchanged.
            // DSH_BROWSER_USER_DATA_DIR (env) flows through as a custom profile,
            // which skips the default-profile running-browser guard.
            await ensureDebugChrome(this.port, envUserDataDir());
        }
        this.opening = this.connectBrowserSocket();
        try {
            await this.opening;
        }
        finally {
            this.opening = null;
        }
    }
    /**
     * Connect (or reconnect) the browser-level WebSocket and arm auto-attach.
     * Resolves once the socket is open and setAutoAttach has been sent.
     */
    async connectBrowserSocket() {
        const wsUrl = await this.browserWebSocketUrl();
        this.intentionalClose = false;
        const socket = new WebSocket(wsUrl, {
            maxPayload: 256 * 1024 * 1024,
        });
        await new Promise((resolve, reject) => {
            const fail = (err) => {
                socket.removeAllListeners();
                socket.terminate();
                reject(err instanceof Error ? err : new Error(String(err)));
            };
            const onOpen = () => {
                socket.removeListener("error", fail);
                resolve();
            };
            socket.once("open", onOpen);
            socket.once("error", fail);
        });
        this.socket = socket;
        this.open = true;
        socket.on("message", (data) => {
            const text = Buffer.isBuffer(data) ? data.toString("utf8") : String(data);
            this.handleMessage(text);
        });
        socket.on("close", (code, reason) => {
            this.handleSocketClose(code, reason);
        });
        socket.on("error", (err) => {
            log(`websocket error: ${err.message}`);
        });
        // Arm auto-attach so we learn sessionIds for page targets as they appear.
        try {
            await this.send("Target.setAutoAttach", {
                autoAttach: true,
                waitForDebuggerOnStart: false,
                flatten: true,
                filter: [{ type: "page" }],
            });
        }
        catch (err) {
            log(`setAutoAttach failed (continuing anyway): ${String(err?.message ?? err)}`);
        }
    }
    /** Fetch the browser-level ws endpoint from /json/version. */
    async browserWebSocketUrl() {
        if (this.browserWsUrl) {
            return this.browserWsUrl;
        }
        const version = await getVersion(this.host, this.port);
        const wsUrl = version.webSocketDebuggerUrl;
        if (!wsUrl) {
            throw new CdpError(`/json/version did not return a webSocketDebuggerUrl (Chrome must be started with --remote-debugging-port)`);
        }
        this.browserWsUrl = wsUrl;
        return wsUrl;
    }
    /** Mark the connection down and remember to reconnect on next use. */
    handleSocketClose(code, reason) {
        this.socket = null;
        const wasOpen = this.open;
        this.open = false;
        // Reject everything still pending; callers will retry via ensureOpen.
        for (const [id, cmd] of [...this.pending.entries()]) {
            clearTimeout(cmd.timer);
            cmd.reject(new CdpError(`websocket closed before response (id=${id}, code=${code})`));
            this.pending.delete(id);
        }
        if (!this.intentionalClose) {
            log(`websocket closed unexpectedly (code=${code}); will reconnect on next use`);
            // Drop cached flat sessions; re-running setAutoAttach on reconnect
            // rebuilds the session map.
            this.reset();
        }
        if (wasOpen) {
            // Notify listeners that the underlying connection dropped.
            this.emitConnectionEvent("Target.connectionClosed", { code });
        }
    }
    /**
     * Close the connection. The socket is closed intentionally; a later
     * send()/ensureOpen() transparently reconnects.
     */
    async close() {
        this.intentionalClose = true;
        this.open = false;
        for (const [id, cmd] of [...this.pending.entries()]) {
            clearTimeout(cmd.timer);
            cmd.reject(new CdpError(`connection closed before response (id=${id})`));
            this.pending.delete(id);
        }
        this.sessionIds.clear();
        for (const session of this.sessions.values()) {
            session.markClosed();
        }
        this.sessions.clear();
        const socket = this.socket;
        this.socket = null;
        if (socket) {
            await new Promise((resolve) => {
                socket.once("close", () => resolve());
                socket.close();
                setTimeout(resolve, 1000).unref?.();
            });
        }
    }
    /** True when the browser WebSocket is currently open. */
    isOpen() {
        return this.open && !!this.socket;
    }
    /**
     * Forget cached session mappings (targetId<->sessionId). Called on
     * reconnect; safe to call any time — setAutoAttach repopulates the map.
     */
    reset() {
        this.sessionIds.clear();
        this.sessions.clear();
    }
    // -------------------------------------------------------------------------
    // Tab enumeration + connection-level HTTP tab ops
    // -------------------------------------------------------------------------
    /**
     * List page targets (type === 'page'), in /json order, with any targets
     * created through {@link createTarget} merged in (they can lag in /json
     * by a few hundred milliseconds).
     */
    async listTabs() {
        await this.ensureOpen();
        const live = (await listTargets(this.host, this.port)).filter((t) => t.type === "page");
        const byId = new Map();
        for (const t of this.cachedTabs.values()) {
            byId.set(t.id, t);
        }
        for (const t of live) {
            byId.set(t.id, t); // live /json data always wins over the cache
        }
        return [...byId.values()];
    }
    /**
     * Attach to a target by id and return a {@link TargetSession} bound to it.
     * Uses an explicit Target.attachToTarget(flatten:true) for determinism,
     * falling back to an already-known auto-attach sessionId when present.
     *
     * @param targetId - Target id from listTabs().
     */
    async attach(targetId) {
        await this.ensureOpen();
        const knownSessionId = this.sessionIds.get(targetId);
        if (knownSessionId) {
            const existing = this.sessions.get(knownSessionId);
            if (existing && !existing.isClosed) {
                return existing;
            }
        }
        const response = await this.send("Target.attachToTarget", {
            targetId,
            flatten: true,
        });
        const sessionId = response?.sessionId;
        if (typeof sessionId !== "string" || sessionId.length === 0) {
            throw new CdpError(`Target.attachToTarget returned no sessionId for target ${targetId}`);
        }
        this.sessionIds.set(targetId, sessionId);
        const session = new TargetSession(this, targetId, sessionId);
        this.sessions.set(sessionId, session);
        return session;
    }
    /**
     * Bring a target to the front (HTTP PUT /json/activate/{id}).
     * Works without an open WebSocket.
     *
     * @param targetId - Target id to activate.
     * @throws CdpError when activation fails (message includes targetId).
     */
    async activateTarget(targetId) {
        let ok;
        try {
            ok = await httpActivateTarget(this.host, this.port, targetId);
        }
        catch (err) {
            if (err instanceof CdpHttpError) {
                throw new CdpError(`activateTarget failed for ${targetId}: ${err.message}`, err.status);
            }
            throw err;
        }
        if (!ok) {
            throw new CdpError(`activateTarget failed for ${targetId} (unknown target?)`);
        }
    }
    /**
     * Create a new tab (HTTP PUT /json/new?url=...). The returned id is merged
     * into the internal tab cache so a subsequent listTabs() finds it even
     * while /json still lags.
     *
     * @param url - URL to open (default "about:blank").
     * @returns The new target's id.
     * @throws CdpError when creation fails.
     */
    async createTarget(url) {
        let target;
        try {
            target = await newTab(this.host, this.port, url);
        }
        catch (err) {
            if (err instanceof CdpHttpError) {
                throw new CdpError(`createTarget failed: ${err.message}`, err.status);
            }
            throw err;
        }
        const targetId = target.id;
        if (!targetId) {
            throw new CdpError("createTarget failed: /json/new returned no target id");
        }
        this.cachedTabs.set(targetId, target);
        // Tolerate /json lag: poll briefly so the target is enumerable by the
        // time this resolves.
        const deadline = Date.now() + 3000;
        for (;;) {
            try {
                const all = await listTargets(this.host, this.port);
                if (all.some((t) => t.id === targetId)) {
                    return targetId;
                }
            }
            catch {
                // /json lag or transient failure — keep waiting until deadline.
            }
            if (Date.now() >= deadline) {
                // Still return the id: it is cached and listTabs() merges the cache,
                // so the tab is reachable even if /json has not caught up.
                log(`createTarget: /json lag for ${targetId}; serving from cache`);
                return targetId;
            }
            await new Promise((r) => setTimeout(r, 100));
        }
    }
    /**
     * Close a target (HTTP PUT /json/close/{id}).
     * Works without an open WebSocket.
     *
     * @param targetId - Target id to close.
     * @returns True when the close was accepted, false when the target id was
     *   unknown.
     * @throws CdpError on transport/HTTP failures (message includes targetId).
     */
    async closeTarget(targetId) {
        this.cachedTabs.delete(targetId);
        try {
            return await httpCloseTarget(this.host, this.port, targetId);
        }
        catch (err) {
            if (err instanceof CdpHttpError) {
                throw new CdpError(`closeTarget failed for ${targetId}: ${err.message}`, err.status);
            }
            throw err;
        }
    }
    // -------------------------------------------------------------------------
    // Browser-level command transport
    // -------------------------------------------------------------------------
    /**
     * Send a CDP command on the BROWSER-level WebSocket.
     *
     * @param method - CDP method name.
     * @param params - Optional command parameters.
     * @param timeoutMs - Per-command timeout (default 30000).
     * @returns The command's `result` object.
     * @throws CdpError on CDP error responses, timeouts, or transport failures.
     */
    async send(method, params, timeoutMs) {
        await this.ensureOpen();
        return this.sendWithSession(method, params, undefined, timeoutMs);
    }
    /**
     * Low-level send used by {@link TargetSession}: routes with sessionId when
     * provided. Does NOT trigger auto-launch by itself (caller ensures open).
     */
    async sendWithSession(method, params, sessionId, timeoutMs) {
        await this.ensureOpen();
        const socket = this.socket;
        if (!socket || !this.open) {
            throw new CdpError("websocket is not open");
        }
        const id = this.nextId++;
        const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
        const message = { id, method };
        if (params !== undefined) {
            message.params = params;
        }
        if (sessionId !== undefined) {
            message.sessionId = sessionId;
        }
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new CdpError(`timeout after ${effectiveTimeout}ms waiting for ${method}`));
            }, effectiveTimeout);
            this.pending.set(id, { resolve, reject, timer });
            try {
                socket.send(JSON.stringify(message));
            }
            catch (err) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new CdpError(`failed to send ${method}: ${String(err?.message ?? err)}`));
            }
        });
    }
    /**
     * Subscribe to browser-level CDP events (everything not scoped to a known
     * session). Session-scoped events are dispatched to the owning
     * TargetSession instead.
     *
     * @param cb - Callback receiving (method, params).
     */
    onEvent(cb) {
        this.connectionListeners.push(cb);
    }
    /** @internal dispatch one incoming JSON-RPC frame. */
    handleMessage(text) {
        let msg;
        try {
            msg = JSON.parse(text);
        }
        catch (err) {
            log(`unparseable frame ignored: ${String(err?.message ?? err)}`);
            return;
        }
        // Command response.
        if (msg && typeof msg.id === "number") {
            const cmd = this.pending.get(msg.id);
            if (!cmd) {
                return;
            }
            clearTimeout(cmd.timer);
            this.pending.delete(msg.id);
            if (msg.error) {
                cmd.reject(new CdpError(String(msg.error.message ?? `CDP error for id=${msg.id}`), typeof msg.error.code === "number" ? msg.error.code : undefined));
            }
            else {
                cmd.resolve(msg.result ?? {});
            }
            return;
        }
        // Event.
        if (msg && typeof msg.method === "string") {
            const method = msg.method;
            const params = msg.params ?? {};
            // Maintain targetId<->sessionId maps from auto-attach lifecycle.
            if (method === "Target.attachedToTarget") {
                const targetId = params?.targetInfo?.id;
                const sessionId = params?.sessionId;
                if (typeof targetId === "string" && typeof sessionId === "string") {
                    this.sessionIds.set(targetId, sessionId);
                    // Expose a session object lazily so tools can subscribe later.
                    if (!this.sessions.has(sessionId)) {
                        this.sessions.set(sessionId, new TargetSession(this, targetId, sessionId));
                    }
                }
            }
            else if (method === "Target.detachedFromTarget") {
                const sessionId = params?.sessionId;
                if (typeof sessionId === "string") {
                    this.forgetSession(sessionId);
                }
            }
            // Route: session-scoped events go to the owning session; everything
            // else to connection-level listeners.
            const sessionId = typeof msg.sessionId === "string" ? msg.sessionId : undefined;
            if (sessionId !== undefined) {
                const session = this.sessions.get(sessionId);
                if (session) {
                    session.emitEvent(method, params);
                    return;
                }
            }
            this.emitConnectionEvent(method, params);
        }
    }
    /**
     * Drop a session mapping (used on detach / close / reset).
     * @internal
     */
    forgetSession(sessionId) {
        this.sessions.delete(sessionId);
        for (const [tid, sid] of [...this.sessionIds.entries()]) {
            if (sid === sessionId) {
                this.sessionIds.delete(tid);
            }
        }
    }
    /** @internal emit to connection-level listeners. */
    emitConnectionEvent(method, params) {
        for (const cb of [...this.connectionListeners]) {
            try {
                cb(method, params);
            }
            catch (err) {
                log(`connection event listener error (${method}): ${String(err?.message ?? err)}`);
            }
        }
    }
}
//# sourceMappingURL=connection.js.map