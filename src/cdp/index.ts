/**
 * Public entry point for the CDP connection layer.
 *
 * Named re-exports only. The implementation modules each own their names;
 * types.js additionally re-exports the runtime surface of connection.js and
 * launcher.js (for @cdp/types consumers), so this index re-exports every
 * public name exactly once:
 *  - connection.js : CdpConnection, TargetSession, CdpError
 *  - launcher.js   : LaunchError, findBrowser, isDebugPortOpen,
 *                    ensureDebugChrome, envPort, envUserDataDir
 *                    (+ EnsureDebugChromeResult, LaunchResult,
 *                    DEFAULT_DEBUG_PORT)
 *  - json.js       : CdpHttpError, fetchJson, getVersion, listTargets,
 *                    newTab, closeTarget, activateTarget
 *  - types.js      : CdpTarget, CdpClientOptions, CdpEventCallback
 */

export type { CdpTarget, CdpClientOptions, CdpEventCallback } from "./types.js";
export { CdpConnection, TargetSession, CdpError } from "./connection.js";
export {
  LaunchError,
  findBrowser,
  isDebugPortOpen,
  ensureDebugChrome,
  envPort,
  envUserDataDir,
  DEFAULT_DEBUG_PORT,
} from "./launcher.js";
export type { EnsureDebugChromeResult, LaunchResult } from "./launcher.js";
export {
  CdpHttpError,
  fetchJson,
  getVersion,
  listTargets,
  newTab,
  closeTarget,
  activateTarget,
} from "./json.js";
