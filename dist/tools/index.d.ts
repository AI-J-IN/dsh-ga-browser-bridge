/**
 * Tool registry for dsh-ga-browser-bridge.
 *
 * Five tools, matching br_mcp.py's TOOLS dict (names, parameter names,
 * action semantics, return shapes). Each tool fn is
 * (args, ctx) => Promise<string>; strings only — never stdout.
 *
 * NOTE: all cdp-layer imports use RELATIVE paths ('../cdp/index.js'). Bare
 * '@cdp/...' specifiers compile under tsconfig paths but MODULE_NOT_FOUND at
 * Node runtime (package.json imports only supports '#' prefixes).
 */
import type { CdpConnection } from '../cdp/index.js';
export interface ToolContext {
    host: string;
    port: number;
    getConnection(): Promise<CdpConnection>;
    getOrCreateBrowser(): Promise<void>;
    defaultTimeoutMs: number;
    /** Current tab, set by switch/create(active); used as the default tab. */
    currentTabId?: string;
    /** Let getConnection auto-launch a debug Chrome when none is running (default true). */
    autoLaunchChrome?: boolean;
}
export interface ToolSpec {
    name: string;
    description: string;
    inputSchema: object;
    fn: (args: any, ctx: ToolContext) => Promise<string>;
}
/**
 * Build a ToolContext. Tests inject a fake connection via overrides.
 * The default getConnection constructs a CdpConnection lazily and reuses it.
 */
export declare function createToolContext(overrides?: Partial<ToolContext>): ToolContext;
/**
 * Thrown by getOrCreateBrowser when Chrome could not be launched; the caller
 * returns its message to the MCP client (br_mcp.py: LaunchError -> message).
 */
export declare class BrowserLaunchError extends Error {
    constructor(message: string);
}
export declare const TOOLS: Record<string, ToolSpec>;
