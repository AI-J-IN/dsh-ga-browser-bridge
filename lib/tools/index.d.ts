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
import type { ExtensionBridgeLike } from './extension-mode.js';
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
    /** Extension transport; when connected it takes priority over CDP. */
    getExtensionBridge?(): Promise<ExtensionBridgeLike | null>;
    /** Force a transport for testing: 'extension' | 'cdp' | 'auto' (default 'auto'). */
    transport?: 'extension' | 'cdp' | 'auto';
    /**
     * Loopback port the extension dials in to. 0 disables the extension
     * transport. Defaults to DSH_BROWSER_EXT_PORT or 18789.
     */
    extensionPort?: number;
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
 *
 * The extension transport is constructed lazily too, and is STRICTLY optional:
 * if the extension module is missing (not built), or its loopback port cannot
 * be bound, `getExtensionBridge()` resolves to null and every tool falls back
 * to the CDP path. It must never throw during plugin mount — a user without
 * the extension installed still has to get a working CDP-only plugin.
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
