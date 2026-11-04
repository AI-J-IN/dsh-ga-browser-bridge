/**
 * Shared types AND the public runtime surface of the CDP layer.
 *
 * Tests and the tools layer import the runtime classes/functions from
 * `@cdp/types` (the repo's moduleNameMapper and the published entry both
 * resolve `@cdp/types` to this module), so the implementations are
 * re-exported here alongside their type declarations.
 */
// --- Runtime surface re-exports -------------------------------------------
//
// connection.ts imports only *types* from this module (import type, erased
// at compile time), so re-exporting its runtime values here creates no
// runtime circular dependency.
export { CdpConnection, TargetSession, CdpError } from "./connection.js";
export { ensureDebugChrome, findBrowser, isDebugPortOpen, LaunchError } from "./launcher.js";
//# sourceMappingURL=types.js.map