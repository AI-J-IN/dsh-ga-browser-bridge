/**
 * Extension-backed implementations of the five browser tools, plus the single
 * routing rule every tool shares.
 *
 * WHY THIS EXISTS
 * ---------------
 * src/cdp needs a debug port, and Chrome 136+ refuses to open one on the
 * default profile — so the CDP path can never reach the browser a user already
 * has open. The extension transport (src/extension, `chrome.debugger`) can.
 * The tools therefore try the extension first and fall back to CDP untouched.
 *
 * CONTRACT STANCE
 * ---------------
 * Nothing here may change what the model sees: the extension implementations
 * return the SAME strings/shapes as the CDP path in ../tools/{tabs,scan,
 * execute,cdp,cookies}.ts. Where the CDP path delegates a decision to a helper
 * (tab resolution, tab rows, "$N.path" batch refs, cookie domain matching), the
 * extension path imports and reuses that helper rather than duplicating it, so
 * the two transports cannot drift apart.
 *
 * TAB IDS
 * -------
 * CDP mode addresses tabs by Chrome *target id* strings; extension mode
 * addresses them by `chrome.tabs` numeric ids. Both are opaque strings to the
 * model, which is fine — but an id remembered from one mode is meaningless in
 * the other, so every lookup that misses returns a clean
 * "[error] tab not found: <id>" instead of crashing (see `findTab`).
 *
 * BRIDGE AVAILABILITY
 * -------------------
 * The bridge module is loaded with a dynamic `import()` inside a try/catch and
 * is treated as purely optional: when it is absent (module not built yet) or
 * the port cannot be bound, `ctx.getExtensionBridge()` resolves to null and
 * every tool silently takes the CDP path. A missing extension must degrade to
 * CDP — never break the plugin mount, never throw into a tool.
 *
 * The `ExtensionBridgeLike` interface below is structurally identical to
 * `ExtensionBridge` in src/extension/bridge.ts. It is declared locally ONLY so
 * this module compiles and runs when that file is missing or mid-edit; the
 * runtime object is whatever `../extension/index.js` exports.
 */
import type { ToolContext } from './index.js';
import { type TabRow } from './cdp.js';
/** A tab as the extension reports it (mirrors protocol.ts `ExtensionTab`). */
export interface ExtensionTabLike {
    /** chrome.tabs id — exposed to the model as the tool's `tab_id`. */
    id: number;
    title: string;
    url: string;
    active: boolean;
    windowId: number;
    status?: string;
}
/** Page snapshot (mirrors protocol.ts `SnapshotResult`). */
export interface SnapshotResultLike {
    content: string;
    truncated: boolean;
    title: string;
    url: string;
}
/** Rendered CDP command for one extension tab. */
export interface ExtensionCdpParams {
    tabId: number;
    method: string;
    params?: Record<string, unknown>;
}
/**
 * The subset of `ExtensionBridge` the tools actually call. Declared
 * structurally so a missing/changed bridge module is a compile-time no-op for
 * the CDP path and a runtime `null` for routing.
 */
export interface ExtensionBridgeLike {
    isConnected(): boolean;
    listTabs(): Promise<ExtensionTabLike[]>;
    evaluate(p: {
        tabId: number;
        expression: string;
        awaitPromise?: boolean;
        returnByValue?: boolean;
    }): Promise<unknown>;
    snapshot(p: {
        tabId: number;
        textOnly?: boolean;
        maxchars?: number;
    }): Promise<SnapshotResultLike>;
    sendCdp(p: ExtensionCdpParams): Promise<unknown>;
    getCookies(p: {
        url?: string;
        all?: boolean;
    }): Promise<unknown[]>;
}
/**
 * Decide which transport this call uses.
 *
 *  - 'auto' (default): extension when a bridge exists AND reports a live
 *    connection; otherwise CDP.
 *  - 'extension': prefer the extension. If no bridge is available or nothing
 *    is connected, fall back to CDP rather than failing the call — a user
 *    without the MV3 extension installed must still get a working plugin
 *    (this is the "missing extension degrades to CDP, never breaks the
 *    plugin" rule, and it is asserted by tests/extension.test.ts #13).
 *  - 'cdp': always CDP, extension ignored entirely.
 *
 * @returns the bridge to use, or `{ bridge: null }` for the CDP path. Must be
 *   called inside the tool's try/catch — `getExtensionBridge()` never rejects,
 *   but a host-supplied override might.
 */
export type RouteDecision = {
    bridge: ExtensionBridgeLike;
    error?: undefined;
} | {
    bridge: null;
    error?: undefined;
};
export declare function routeTransport(ctx: ToolContext): Promise<RouteDecision>;
/**
 * Resolve the target tab in extension mode.
 *
 * Reuses the CDP path's `resolveTab` (same explicit -> ctx.currentTabId ->
 * first order) by presenting the bridge's tab list through the structural
 * `CdpListConnection` it expects. Returns null when the browser has no tabs.
 *
 * A `tab_id` that matches nothing falls through to currentTabId/first exactly
 * like the CDP path; tools that must reject an unknown id use `findTab`.
 */
export declare function resolveExtensionTab(bridge: ExtensionBridgeLike, explicitTabId: unknown, ctx: ToolContext): Promise<ExtensionTabLike | null>;
/** Find a tab by its exact id string; null when it is gone (stale/foreign id). */
export declare function findTab(bridge: ExtensionBridgeLike, wanted: string): Promise<ExtensionTabLike | null>;
/** The {id,title,url} row the CDP path emits — same helper, same output. */
export declare function extensionTabRow(t: ExtensionTabLike): TabRow;
/** True when `s` is a usable chrome.tabs numeric id. */
export declare function asTabId(id: unknown): number | null;
/**
 * Extension twin of `browser_tabs`. Mirrors ../../tools/tabs.ts branch by
 * branch so that action strings, error strings and JSON shapes are identical.
 */
export declare function browserTabsViaExtension(args: Record<string, any>, ctx: ToolContext, bridge: ExtensionBridgeLike): Promise<string>;
/** Extension twin of `browser_scan`: snapshot, honour text_only/maxchars. */
export declare function browserScanViaExtension(args: Record<string, any>, ctx: ToolContext, bridge: ExtensionBridgeLike): Promise<string>;
/** Extension twin of `browser_execute_js`. */
export declare function browserExecuteJsViaExtension(args: Record<string, any>, ctx: ToolContext, bridge: ExtensionBridgeLike): Promise<string>;
/** Extension twin of `browser_cdp` (single + batch). */
export declare function browserCdpViaExtension(args: Record<string, any>, ctx: ToolContext, bridge: ExtensionBridgeLike): Promise<string>;
/** Extension twin of `browser_cookies`. */
export declare function browserCookiesViaExtension(args: Record<string, any>, ctx: ToolContext, bridge: ExtensionBridgeLike): Promise<string>;
