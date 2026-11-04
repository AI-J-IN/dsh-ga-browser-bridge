/**
 * Wire protocol between the DSH plugin (host side) and the browser extension.
 *
 * WHY THIS EXISTS
 * ---------------
 * Chrome 136+ silently ignores `--remote-debugging-port` on the DEFAULT
 * profile, and an already-running Chrome can never open the port after the
 * fact. So the port-based transport (src/cdp) cannot attach to the browser a
 * user already has open.
 *
 * `chrome.debugger` is Chrome's official "alternate transport for the remote
 * debugging protocol" (developer.chrome.com/docs/extensions/reference/api/debugger).
 * An extension using it can drive the CURRENTLY OPEN browser — with the user's
 * existing logins — without any debug port and without restarting Chrome.
 *
 * Topology:
 *
 *   DSH plugin (Node)                        Browser
 *   ┌────────────────────┐                ┌──────────────────────────┐
 *   │ ExtensionBridge    │◀── WebSocket ──│ MV3 service worker       │
 *   │  ws://127.0.0.1:PORT│    (extension  │  chrome.debugger.attach()│
 *   │  serves the socket  │     dials out) │  chrome.tabs.*           │
 *   └────────────────────┘                └──────────────────────────┘
 *
 * The EXTENSION dials out to the plugin, not the other way around: a service
 * worker cannot listen on a TCP port, but it may open WebSocket client
 * connections.
 *
 * Message shape: JSON-RPC-ish request/response over one socket, with optional
 * server-initiated events. Every request carries an id chosen by the host.
 */
/** Protocol version. Bump on any breaking change; both sides check it. */
export const EXTENSION_PROTOCOL_VERSION = 1;
/** Default loopback port the plugin listens on for the extension. */
export const EXTENSION_DEFAULT_PORT = 18789;
/** How long a single extension round-trip may take (ms). */
export const EXTENSION_REQUEST_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// Type guards (used on both sides; keep dependency-free)
// ---------------------------------------------------------------------------
export function isRequest(msg) {
    return (typeof msg === 'object' &&
        msg !== null &&
        typeof msg.id === 'number' &&
        typeof msg.method === 'string');
}
export function isResponse(msg) {
    return (typeof msg === 'object' &&
        msg !== null &&
        typeof msg.id === 'number' &&
        typeof msg.ok === 'boolean');
}
export function isEvent(msg) {
    return (typeof msg === 'object' &&
        msg !== null &&
        typeof msg.method === 'string' &&
        typeof msg.id !== 'number');
}
/** Build a success response. */
export function ok(id, result) {
    return { id, ok: true, result };
}
/** Build a failure response. */
export function fail(id, code, message, detail) {
    return { id, ok: false, error: { code, message, detail } };
}
//# sourceMappingURL=protocol.js.map