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
import type { CdpClientOptions, CdpEventCallback, CdpTarget } from "./types.js";
/** CDP protocol-level error (command error response, timeout, etc.). */
export declare class CdpError extends Error {
    readonly code?: number | undefined;
    constructor(message: string, code?: number | undefined);
}
/**
 * A flat-protocol session bound to one target. Commands sent through it are
 * routed with a top-level `sessionId` on the wire; events emitted by the
 * target arrive with that sessionId and are re-dispatched to the session's
 * listeners.
 */
export declare class TargetSession {
    /** Target id this session is bound to. */
    readonly targetId: string;
    private readonly conn;
    private readonly sessionId;
    private listeners;
    private closed;
    /** @internal */
    constructor(conn: CdpConnection, targetId: string, sessionId: string);
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
    send(method: string, params?: object, timeoutMs?: number): Promise<any>;
    /**
     * Subscribe to events emitted on this target session.
     * @param cb - Callback receiving (method, params).
     */
    onEvent(cb: CdpEventCallback): void;
    /**
     * Close the session (Target.detachFromTarget). The session object becomes
     * unusable afterwards; closing twice is a no-op.
     */
    close(): Promise<void>;
    /** @internal dispatch an incoming event to this session's listeners. */
    emitEvent(method: string, params: any): void;
    /** @internal mark closed without touching the wire (used by connection close). */
    markClosed(): void;
    /** @internal */
    get isClosed(): boolean;
    /** @internal */
    get id(): string;
}
/**
 * Browser-level CDP connection over one WebSocket.
 *
 * Lifecycle: construct lazily — the socket is opened on first ensureOpen() or
 * send(). ensureOpen() additionally guarantees a debuggable Chrome exists:
 * it probes the TCP debug port, and when autoLaunch is enabled (default) and
 * the port is closed it launches Chrome (reusing the default profile so
 * login state is preserved) before connecting.
 */
export declare class CdpConnection {
    private readonly host;
    private readonly port;
    private readonly defaultTimeoutMs;
    private readonly autoLaunch;
    private socket;
    private opening;
    private open;
    private intentionalClose;
    private nextId;
    private readonly pending;
    private connectionListeners;
    /** targetId -> sessionId (flat protocol), maintained via auto-attach. */
    private readonly sessionIds;
    /** sessionId -> TargetSession for event routing. */
    private readonly sessions;
    /** HTTP-level tab cache merged into listTabs() results (createTarget lag). */
    private readonly cachedTabs;
    private browserWsUrl;
    /**
     * @param host - Debug host (e.g. "127.0.0.1").
     * @param port - Debug port (e.g. 9222).
     * @param options - Optional overrides: timeoutMs (per-command WS timeout),
     *   host/port (alternate way to supply host/port), autoLaunch (default
     *   true; when false, ensureOpen() throws CdpError instead of launching
     *   Chrome when the debug port is closed).
     */
    constructor(host: string, port: number, options?: CdpClientOptions);
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
    ensureOpen(): Promise<void>;
    /**
     * Connect (or reconnect) the browser-level WebSocket and arm auto-attach.
     * Resolves once the socket is open and setAutoAttach has been sent.
     */
    private connectBrowserSocket;
    /** Fetch the browser-level ws endpoint from /json/version. */
    private browserWebSocketUrl;
    /** Mark the connection down and remember to reconnect on next use. */
    private handleSocketClose;
    /**
     * Close the connection. The socket is closed intentionally; a later
     * send()/ensureOpen() transparently reconnects.
     */
    close(): Promise<void>;
    /** True when the browser WebSocket is currently open. */
    isOpen(): boolean;
    /**
     * Forget cached session mappings (targetId<->sessionId). Called on
     * reconnect; safe to call any time — setAutoAttach repopulates the map.
     */
    reset(): void;
    /**
     * List page targets (type === 'page'), in /json order, with any targets
     * created through {@link createTarget} merged in (they can lag in /json
     * by a few hundred milliseconds).
     */
    listTabs(): Promise<CdpTarget[]>;
    /**
     * Attach to a target by id and return a {@link TargetSession} bound to it.
     * Uses an explicit Target.attachToTarget(flatten:true) for determinism,
     * falling back to an already-known auto-attach sessionId when present.
     *
     * @param targetId - Target id from listTabs().
     */
    attach(targetId: string): Promise<TargetSession>;
    /**
     * Bring a target to the front (HTTP PUT /json/activate/{id}).
     * Works without an open WebSocket.
     *
     * @param targetId - Target id to activate.
     * @throws CdpError when activation fails (message includes targetId).
     */
    activateTarget(targetId: string): Promise<void>;
    /**
     * Create a new tab (HTTP PUT /json/new?url=...). The returned id is merged
     * into the internal tab cache so a subsequent listTabs() finds it even
     * while /json still lags.
     *
     * @param url - URL to open (default "about:blank").
     * @returns The new target's id.
     * @throws CdpError when creation fails.
     */
    createTarget(url?: string): Promise<string>;
    /**
     * Close a target (HTTP PUT /json/close/{id}).
     * Works without an open WebSocket.
     *
     * @param targetId - Target id to close.
     * @returns True when the close was accepted, false when the target id was
     *   unknown.
     * @throws CdpError on transport/HTTP failures (message includes targetId).
     */
    closeTarget(targetId: string): Promise<boolean>;
    /**
     * Send a CDP command on the BROWSER-level WebSocket.
     *
     * @param method - CDP method name.
     * @param params - Optional command parameters.
     * @param timeoutMs - Per-command timeout (default 30000).
     * @returns The command's `result` object.
     * @throws CdpError on CDP error responses, timeouts, or transport failures.
     */
    send(method: string, params?: object, timeoutMs?: number): Promise<any>;
    /**
     * Low-level send used by {@link TargetSession}: routes with sessionId when
     * provided. Does NOT trigger auto-launch by itself (caller ensures open).
     */
    sendWithSession(method: string, params: object | undefined, sessionId: string | undefined, timeoutMs?: number): Promise<any>;
    /**
     * Subscribe to browser-level CDP events (everything not scoped to a known
     * session). Session-scoped events are dispatched to the owning
     * TargetSession instead.
     *
     * @param cb - Callback receiving (method, params).
     */
    onEvent(cb: CdpEventCallback): void;
    /** @internal dispatch one incoming JSON-RPC frame. */
    private handleMessage;
    /**
     * Drop a session mapping (used on detach / close / reset).
     * @internal
     */
    forgetSession(sessionId: string): void;
    /** @internal emit to connection-level listeners. */
    private emitConnectionEvent;
}
