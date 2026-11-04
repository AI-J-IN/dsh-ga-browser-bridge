/**
 * Shared types AND the public runtime surface of the CDP layer.
 *
 * Tests and the tools layer import the runtime classes/functions from
 * `@cdp/types` (the repo's moduleNameMapper and the published entry both
 * resolve `@cdp/types` to this module), so the implementations are
 * re-exported here alongside their type declarations.
 */
/** A browser target as reported by the HTTP /json endpoints. */
export interface CdpTarget {
    id: string;
    type: string;
    title: string;
    url: string;
    webSocketDebuggerUrl?: string;
}
/**
 * Options accepted by CdpConnection.
 *
 * `timeoutMs` is the default per-command WebSocket timeout (default 30000
 * ms). `host`/`port` are also accepted here for callers that prefer to
 * configure the connection through options instead of the constructor
 * positional args. `autoLaunch` (default true) makes ensureOpen() launch a
 * debuggable Chrome when the debug port is closed; when false, ensureOpen()
 * throws CdpError instead.
 */
export interface CdpClientOptions {
    port?: number;
    host?: string;
    timeoutMs?: number;
    autoLaunch?: boolean;
}
/** Callback invoked for every CDP event received on a connection/session. */
export type CdpEventCallback = (method: string, params: any) => void;
export { CdpConnection, TargetSession, CdpError } from "./connection.js";
export { ensureDebugChrome, findBrowser, isDebugPortOpen, LaunchError } from "./launcher.js";
export type { EnsureDebugChromeResult, LaunchResult } from "./launcher.js";
