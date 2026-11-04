/**
 * browser_cdp — raw Chrome DevTools Protocol passthrough — plus the shared
 * tab-resolution / response-shape helpers used by all five tools.
 *
 * browser_cdp br_mcp.py parity:
 *  - method (single) OR commands (batch array of {cmd?, method, params?, tabId?})
 *  - "[error] need method or commands" when neither is given
 *  - batch: results array in order; later commands may reference prior
 *    results with "$N.x" strings (N = 0-based index into the results array,
 *    dot path into the referenced result)
 *  - timeout param (seconds, default 30)
 *  - CDP errors surface as "[error] <message>"
 *
 * Routing: page-level methods go through the resolved tab's TargetSession
 * (sessionId-routed session.send). Tab ops stay on the connection.
 *
 * Response shapes: a real CdpConnection unwraps the CDP wire envelope
 * ({result: {...}}); the test fake returns the raw envelope. Helpers below
 * (unwrap / exceptionDetailsOf / evaluateValueOf / resolveRef) accept both.
 */
import type { ToolContext } from './index.js';
/** Minimal structural surface: listTabs (every tool needs it). */
export interface CdpListConnection {
    listTabs(): Promise<any[]>;
}
/** Structural surface adding the plan-A tab ops (browser_tabs only). */
export interface CdpLikeConnection extends CdpListConnection {
    attach(targetId: string): Promise<CdpLikeSession>;
    createTarget(url: string): Promise<string>;
    activateTarget(targetId: string): Promise<void>;
    closeTarget(targetId: string): Promise<boolean>;
}
export interface CdpLikeSession {
    readonly targetId: string;
    send(method: string, params?: any, timeoutMs?: number): Promise<any>;
    close(): Promise<void>;
}
/** One tab row as browser_tabs list/find report them. */
export interface TabRow {
    id: string;
    title: string;
    url: string;
}
/** Normalize a tab id argument: null/""/"0" -> null (use default). */
export declare function normalizeTabId(tabId: unknown): string | null;
/**
 * Resolve the target tab: explicit id -> ctx.currentTabId -> first tab.
 * Returns the tab object or null when there are no tabs.
 */
export declare function resolveTab(conn: CdpListConnection, explicitTabId: unknown, currentTabId?: string): Promise<any | null>;
/** Resolve with the context default (explicit arg -> currentTabId -> first). */
export declare function resolveToolTab(conn: CdpListConnection, explicitTabId: unknown, ctx: ToolContext): Promise<any | null>;
/** The no-browser error string (br_mcp.py _need_browser()). */
export declare function noBrowser(): string;
/** Format a target as the {id,title,url} row br_mcp.py returned. */
export declare function tabRow(t: any): TabRow;
/**
 * Read `key` from res, tolerating both the unwrapped payload (real
 * connection: {cookies: [...]}) and the raw wire envelope (test fake:
 * {result: {result: {value}}} — CDP wraps the payload in a "result" field,
 * and the fake does not unwrap it). Searches res, res.result, and
 * res.result.result.
 */
export declare function unwrap(res: any, key: string): any;
/** exceptionDetails from any of the accepted shapes. */
export declare function exceptionDetailsOf(res: any): any;
/** Evaluated value from any of the accepted shapes. */
export declare function evaluateValueOf(res: any): any;
export declare function browser_cdp(args: Record<string, any>, ctx: ToolContext): Promise<string>;
/**
 * Deep-resolve "$N.path" string references against priorResults (N is the
 * 0-based command index; br_mcp.py: "$N.x refs to prior results"). Each
 * lookup tries the raw result and its .result envelope.
 */
export declare function resolveRefs(value: any, prior: any[]): any;
