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
export const EXTENSION_PROTOCOL_VERSION = 1

/** Default loopback port the plugin listens on for the extension. */
export const EXTENSION_DEFAULT_PORT = 18765

/** How long a single extension round-trip may take (ms). */
export const EXTENSION_REQUEST_TIMEOUT_MS = 30_000

// ---------------------------------------------------------------------------
// Host -> Extension requests
// ---------------------------------------------------------------------------

export type ExtensionRequest =
  | { id: number; method: 'ping' }
  | { id: number; method: 'tabs.list' }
  | { id: number; method: 'tabs.get'; params: { tabId: number } }
  | { id: number; method: 'tabs.create'; params: { url?: string; active?: boolean } }
  | { id: number; method: 'tabs.activate'; params: { tabId: number } }
  | { id: number; method: 'tabs.close'; params: { tabId: number } }
  | { id: number; method: 'tabs.reload'; params: { tabId: number } }
  | { id: number; method: 'page.evaluate'; params: EvaluateParams }
  | { id: number; method: 'page.snapshot'; params: SnapshotParams }
  | { id: number; method: 'cdp.send'; params: CdpSendParams }
  | { id: number; method: 'cookies.get'; params: CookiesParams }

/**
 * A request BEFORE the host assigns an id.
 *
 * Declared separately instead of `Omit<ExtensionRequest, 'id'>` because
 * Omit over a union collapses it to the members' common keys, which would
 * drop `params` entirely and make every parameterised call a type error.
 */
export type ExtensionRequestPayload = ExtensionRequest extends infer R
  ? R extends { id: number }
    ? Omit<R, 'id'>
    : never
  : never

export interface EvaluateParams {
  tabId: number
  /** JavaScript source. An expression, or a function body when `awaitPromise`. */
  expression: string
  /** Evaluate as an async function so `await` works inside (default true). */
  awaitPromise?: boolean
  /** Return the value by value rather than a remote object handle (default true). */
  returnByValue?: boolean
}

export interface SnapshotParams {
  tabId: number
  /** Return only visible text instead of (simplified) HTML. */
  textOnly?: boolean
  /** Max characters of the result (default 35000). */
  maxchars?: number
}

export interface CdpSendParams {
  tabId: number
  /** CDP method, e.g. "Page.captureScreenshot". */
  method: string
  /** CDP parameters. May contain "$N.path" refs resolved by the HOST batch runner. */
  params?: Record<string, unknown>
}

export interface CookiesParams {
  /** Restrict to the given URL (usually the tab's URL). Omit for all cookies. */
  url?: string
  /** Also return cookies for every matching domain (default true). */
  all?: boolean
}

// ---------------------------------------------------------------------------
// Extension -> Host responses
// ---------------------------------------------------------------------------

export type ExtensionResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: ExtensionErrorBody }

export interface ExtensionErrorBody {
  /** Stable machine code, e.g. "NO_TAB", "ATTACH_FAILED", "CDP_ERROR". */
  code: string
  message: string
  /** Extra diagnostic detail (never surfaced as an instruction to the model). */
  detail?: string
}

// ---------------------------------------------------------------------------
// Extension -> Host notifications (no id, host may ignore)
// ---------------------------------------------------------------------------

export type ExtensionEvent =
  | { method: 'hello'; protocolVersion: number; extensionVersion: string; browser: string }
  | { method: 'tabs.changed'; tabId: number; change: 'created' | 'removed' | 'updated' }
  | { method: 'debugger.detached'; tabId: number; reason: string }

// ---------------------------------------------------------------------------
// Shared result shapes (both sides must agree)
// ---------------------------------------------------------------------------

/** A tab as reported by the extension (maps onto the plugin's CdpTarget shape). */
export interface ExtensionTab {
  /** chrome.tabs id — the plugin exposes this as the tool's `tab_id`. */
  id: number
  title: string
  url: string
  active: boolean
  windowId: number
  status?: string
}

export interface SnapshotResult {
  /** Simplified HTML, or visible text when textOnly was requested. */
  content: string
  /** True when the result was truncated to maxchars. */
  truncated: boolean
  /** Page title at snapshot time (helps the model orient). */
  title: string
  url: string
}

export interface EvaluateResult {
  /** The evaluated value (already serialized when returnByValue). */
  value: unknown
  /** Present when the page threw. */
  exception?: string
}

// ---------------------------------------------------------------------------
// Type guards (used on both sides; keep dependency-free)
// ---------------------------------------------------------------------------

export function isRequest(msg: unknown): msg is ExtensionRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { id?: unknown }).id === 'number' &&
    typeof (msg as { method?: unknown }).method === 'string'
  )
}

export function isResponse(msg: unknown): msg is ExtensionResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { id?: unknown }).id === 'number' &&
    typeof (msg as { ok?: unknown }).ok === 'boolean'
  )
}

export function isEvent(msg: unknown): msg is ExtensionEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    typeof (msg as { method?: unknown }).method === 'string' &&
    typeof (msg as { id?: unknown }).id !== 'number'
  )
}

/** Build a success response. */
export function ok(id: number, result: unknown): ExtensionResponse {
  return { id, ok: true, result }
}

/** Build a failure response. */
export function fail(id: number, code: string, message: string, detail?: string): ExtensionResponse {
  return { id, ok: false, error: { code, message, detail } }
}
