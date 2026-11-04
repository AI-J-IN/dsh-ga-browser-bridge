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
import type { CdpSendParams, CookiesParams, EvaluateParams, ExtensionEvent, ExtensionRequestPayload, ExtensionTab, SnapshotParams, SnapshotResult } from './protocol.js';
/** Every error this module throws (and the `code` values callers switch on). */
export type ExtensionBridgeErrorCode = 
/** Server could not bind: another process owns the port. */
'PORT_IN_USE'
/** Server could not bind for another reason (permissions, bad port, ...). */
 | 'BIND_FAILED'
/** No extension socket is able to receive the request right now. */
 | 'NO_EXTENSION'
/** The extension did not answer within the request timeout. */
 | 'TIMEOUT'
/** The socket closed while requests were in flight. */
 | 'DISCONNECTED'
/** Writing the frame to the socket failed. */
 | 'SEND_FAILED'
/** The extension answered with a structured failure body. */
 | 'EXTENSION_ERROR';
/**
 * Error type for every failure surfaced by {@link ExtensionBridge}.
 *
 * `code` is a stable machine code (see {@link ExtensionBridgeErrorCode}) so
 * the tools layer can map it onto user-facing text without string matching.
 * `detail` carries extra diagnostics and is never an instruction.
 */
export declare class ExtensionBridgeError extends Error {
    readonly code: string;
    readonly detail?: string | undefined;
    constructor(message: string, code: string, detail?: string | undefined);
}
/** Constructor options. All optional; defaults come from protocol.ts. */
export interface ExtensionBridgeOptions {
    /** Loopback TCP port to listen on. Default {@link EXTENSION_DEFAULT_PORT}. */
    port?: number;
    /** Per-request round-trip budget in ms. Default {@link EXTENSION_REQUEST_TIMEOUT_MS}. */
    requestTimeoutMs?: number;
}
export declare class ExtensionBridge {
    /** Port the server binds (and the extension dials). */
    readonly port: number;
    /** Per-request timeout budget in ms. */
    readonly requestTimeoutMs: number;
    /** Protocol version this host speaks (shipped for the tools/diagnostic layer). */
    readonly protocolVersion: number;
    private server;
    private starting;
    private stopping;
    private readonly peers;
    private peerSeq;
    private readonly pending;
    private readonly listeners;
    private nextId;
    constructor(options?: ExtensionBridgeOptions);
    /**
     * Start listening on 127.0.0.1:PORT. Idempotent: concurrent or repeated
     * calls share one promise and resolve once the server is bound.
     *
     * @throws ExtensionBridgeError `PORT_IN_USE` when another process owns the
     *   port, `BIND_FAILED` for any other bind failure.
     */
    start(): Promise<void>;
    /**
     * Stop listening and close every extension socket. Idempotent and safe to
     * call when never started. All in-flight requests are rejected with
     * 'DISCONNECTED'.
     */
    stop(): Promise<void>;
    /**
     * True when at least one extension socket has completed the `hello`
     * handshake. A socket that connected but never said hello does NOT count.
     */
    isConnected(): boolean;
    /** Number of connected extension sockets (accepted ones; normally 0 or 1). */
    connectionCount(): number;
    /**
     * Register a listener for extension events (`hello`, `tabs.changed`,
     * `debugger.detached`). Listeners are append-only for the lifetime of the
     * bridge; a throwing listener is logged and cannot affect the others.
     */
    onEvent(cb: (evt: ExtensionEvent) => void): void;
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
    request(req: ExtensionRequestPayload): Promise<unknown>;
    /**
     * List the user's browser tabs.
     *
     * Note: this returns whatever the extension sends; the tool layer is
     * expected to validate the shape (see `normalizeTabs` for the defensive
     * version the bridge applies to its own convenience wrapper).
     */
    rawListTabs(): Promise<unknown>;
    /** List the user's browser tabs (`chrome.tabs.query({})` shape). */
    listTabs(): Promise<ExtensionTab[]>;
    /**
     * Evaluate JavaScript in a tab.
     *
     * Unwraps the extension's `EvaluateResult` envelope: returns its `value`
     * when present, and throws ExtensionBridgeError('PAGE_ERROR') when the page
     * threw (the exception text is the message).
     */
    evaluate(params: EvaluateParams): Promise<unknown>;
    /** Capture a page snapshot (simplified HTML, or visible text when textOnly). */
    snapshot(params: SnapshotParams): Promise<SnapshotResult>;
    /** Send a raw CDP command to a tab's debugger session. */
    sendCdp(params: CdpSendParams): Promise<unknown>;
    /** Read cookies (the tab's origin, or every domain when `all`). */
    getCookies(params: CookiesParams): Promise<unknown[]>;
    /**
     * Pick where a request goes: the first socket that completed `hello`, else
     * the most recently accepted socket (it may still be mid-handshake).
     * Returns null when nothing is connected at all.
     */
    private selectPeer;
    /** Error raised when `request()` has no socket to talk to. */
    private noExtensionError;
    /** Track a freshly accepted socket and wire its handlers. */
    private adoptSocket;
    /** Parse and dispatch one inbound frame. Unparseable frames are logged and ignored. */
    private handleFrame;
    /** Resolve or reject the pending entry that matches a response frame. */
    private settle;
    /** Fan an event out to listeners; `hello` also promotes the socket to ready. */
    private dispatchEvent;
    /**
     * Drop a peer and reject anything that was in flight on it. Requests sent to
     * other (still open) sockets are left alone.
     */
    private removePeer;
    /** Reject every in-flight request with a fresh error from `make`. */
    private rejectAllPending;
    /** Best-effort close of one socket; terminates if it does not go quietly. */
    private closePeer;
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
export declare function normalizeTabs(result: unknown): ExtensionTab[];
