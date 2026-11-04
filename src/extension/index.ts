/**
 * Public entry point for the extension transport.
 *
 * The extension bridge is an ALTERNATE transport to src/cdp: instead of a
 * debug port (which Chrome 136+ refuses on the default profile, and which an
 * already-running browser never opens), a browser extension using
 * `chrome.debugger` dials out to {@link ExtensionBridge} over a loopback
 * WebSocket. See ./protocol.ts for the wire contract.
 *
 * Named re-exports only (no `export *`), so the runtime surface is explicit
 * and stays collision-free if protocol.ts and bridge.ts ever share a name.
 *
 * protocol.js : EXTENSION_PROTOCOL_VERSION, EXTENSION_DEFAULT_PORT,
 *               EXTENSION_REQUEST_TIMEOUT_MS, isRequest, isResponse, isEvent,
 *               ok, fail
 * bridge.js   : ExtensionBridge, ExtensionBridgeError, normalizeTabs
 */

// ---------------------------------------------------------------------------
// Protocol constants, guards and frame builders (./protocol.ts)
// ---------------------------------------------------------------------------
export {
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_DEFAULT_PORT,
  EXTENSION_REQUEST_TIMEOUT_MS,
  isRequest,
  isResponse,
  isEvent,
  ok,
  fail,
} from './protocol.js'

export type {
  /** Host -> extension request union (each member carries its own `id`). */
  ExtensionRequest,
  /** A request without its `id`: what {@link ExtensionBridge.request} takes. */
  ExtensionRequestPayload,
  /** Extension -> host response union. */
  ExtensionResponse,
  /** Structured failure body carried by a failed response. */
  ExtensionErrorBody,
  /** Extension -> host notification union (`hello`/`tabs.changed`/`debugger.detached`). */
  ExtensionEvent,
  /** Shared tab shape; `id` is the tool-facing `tab_id`. */
  ExtensionTab,
  /** Shared snapshot result shape. */
  SnapshotResult,
  /** Shared evaluate result shape. */
  EvaluateResult,
  /** Params for `page.evaluate`. */
  EvaluateParams,
  /** Params for `page.snapshot`. */
  SnapshotParams,
  /** Params for `cdp.send`. */
  CdpSendParams,
  /** Params for `cookies.get`. */
  CookiesParams,
} from './protocol.js'

// ---------------------------------------------------------------------------
// Host-side bridge (./bridge.ts)
// ---------------------------------------------------------------------------
export { ExtensionBridge, ExtensionBridgeError, normalizeTabs } from './bridge.js'

export type {
  /** Constructor options: `port` and `requestTimeoutMs`. */
  ExtensionBridgeOptions,
  /** Union of the `code` values ExtensionBridgeError can carry. */
  ExtensionBridgeErrorCode,
} from './bridge.js'
