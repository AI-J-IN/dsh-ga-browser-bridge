/**
 * Chrome discovery and debug-instance launching for the CDP bridge.
 *
 * Goal: talk to the user's REAL Chrome (with their login state) at
 * 127.0.0.1:<port>. We never kill a running browser: if Chrome is already
 * running without a debug port we surface a clear LaunchError instead of
 * spawning a second instance that would just hand off to the first one
 * (profile lock) and never open the debug port.
 *
 * All diagnostics go to stderr — never stdout (MCP stdio protocol channel).
 */
/** Thrown when Chrome cannot be launched or located for debugging. */
export declare class LaunchError extends Error {
    readonly code?: number | undefined;
    constructor(message: string, code?: number | undefined);
}
/** Default debug port for the bridge. */
export declare const DEFAULT_DEBUG_PORT = 9222;
/**
 * Env override for the debug port (README-documented). Returns undefined
 * when unset or unparseable so callers can fall back to their own default.
 */
export declare function envPort(): number | undefined;
/**
 * Env override for a separate Chrome profile dir (README-documented).
 * A custom profile does NOT conflict with the default profile lock, so
 * callers use its presence to skip the "browser already running" guard.
 */
export declare function envUserDataDir(): string | undefined;
/**
 * Find a usable Chrome/Chromium/Edge executable on this machine.
 *
 * Probes, in order: env CHROME_PATH / DSH_BROWSER_PATH overrides, then the
 * platform's well-known install locations (Windows Chrome + Edge, macOS
 * Chrome/Chromium/Edge, Linux binaries incl. google-chrome-stable and the
 * snap path).
 *
 * @returns `{ path, name }` for the first candidate that exists on disk, or
 *   `null` when nothing was found.
 */
export declare function findBrowser(): {
    path: string;
    name: string;
} | null;
/**
 * Raw TCP connect probe: is something listening on host:port?
 *
 * @param port - TCP port to probe.
 * @param host - TCP host (default "127.0.0.1").
 * @returns Promise resolving to true when a TCP connection was established.
 */
export declare function isDebugPortOpen(port: number, host?: string): Promise<boolean>;
/**
 * Result of launching a browser manually (kept for contract compatibility
 * with the original bridge design; ensureDebugChrome's own return type is
 * {@link EnsureDebugChromeResult}).
 */
export interface LaunchResult {
    browserPath: string;
    args: string[];
    port: number;
    userDataDir: string;
    restarted: boolean;
}
export interface EnsureDebugChromeResult {
    alreadyRunning: boolean;
    launched: boolean;
    port: number;
    userDataDir: string;
}
/**
 * Ensure a debuggable Chrome is listening on 127.0.0.1:port.
 *
 * Env fallbacks (README-documented): when `port` is not supplied (or is
 * undefined), DSH_BROWSER_PORT is consulted next; when `userDataDir` is not
 * supplied, DSH_BROWSER_USER_DATA_DIR is consulted next. Explicit arguments
 * always win over the env overrides.
 *
 * Decision table (mirrors br_mcp.py behavior):
 *  1. Port already open  -> reuse it (alreadyRunning=true, launched=false).
 *     We never spawn when a debug port is already listening.
 *  2. Port closed AND a Chrome process is running AND no custom profile is
 *     in play (default-profile reuse) -> the running Chrome holds the
 *     profile lock; a second instance with the same user-data-dir would just
 *     hand off to it and never open the debug port. Throws LaunchError
 *     telling the user to close Chrome or set DSH_BROWSER_USER_DATA_DIR. We
 *     never kill any process.
 *     SKIPPED when a custom profile IS in play: an explicit userDataDir
 *     argument OR a DSH_BROWSER_USER_DATA_DIR env override means we launch
 *     with a SEPARATE user-data-dir, which does not conflict with the
 *     default profile lock - the user's default Chrome may keep running.
 *     Fall through to step 3.
 *  3. Port closed AND (no Chrome running OR custom profile in play) ->
 *     launch Chrome with --remote-debugging-port=<port>
 *     --remote-debugging-address=127.0.0.1, --no-first-run
 *     --no-default-browser-check. For the DEFAULT profile we pass NO
 *     --user-data-dir so the real profile (login state) is used; a custom
 *     userDataDir is passed explicitly. The child is spawned detached with
 *     ignored stdio and unref()'d so plugin exit does not kill it.
 *
 * After spawn we poll isDebugPortOpen for up to 20s, then GET /json/version
 * for up to 10s more. On failure we throw LaunchError whose message includes
 * the exact command the user can run manually.
 *
 * @param port - Debug port (default 9222; DSH_BROWSER_PORT env is the
 *   fallback when omitted/undefined).
 * @param userDataDir - Custom profile dir; when omitted the
 *   DSH_BROWSER_USER_DATA_DIR env override is consulted, then the OS default
 *   profile is reused so login state is preserved.
 * @returns Result describing what happened.
 */
export declare function ensureDebugChrome(port?: number, userDataDir?: string): Promise<EnsureDebugChromeResult>;
