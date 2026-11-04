export { name, inject, apply, Config } from './plugin.js'
export type { PluginConfig } from './plugin.js'
export { TOOLS, createToolContext } from './tools/index.js'
export type { ToolSpec, ToolContext } from './tools/index.js'
export { ExtensionBridge, ExtensionBridgeError } from './extension/index.js'
export type {
  ExtensionBridgeOptions,
  ExtensionBridgeErrorCode,
  ExtensionTab,
  ExtensionRequest,
  ExtensionResponse,
  ExtensionEvent,
  ExtensionRequestPayload,
  SnapshotResult,
  EvaluateResult,
  EvaluateParams,
  SnapshotParams,
  CdpSendParams,
  CookiesParams,
} from './extension/index.js'
export {
  EXTENSION_DEFAULT_PORT,
  EXTENSION_PROTOCOL_VERSION,
  EXTENSION_REQUEST_TIMEOUT_MS,
} from './extension/index.js'
export * from './cdp/index.js'
