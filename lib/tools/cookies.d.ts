/**
 * browser_cookies — read cookies (incl. HttpOnly) for the tab's origin.
 *
 * br_mcp.py parity:
 *  - tab_id optional; defaults like _cur_tab (explicit -> current -> first).
 *  - no tab resolvable -> no-browser error string.
 *
 * CDP mapping: Network.getAllCookies is a browser-level command (returns
 * every cookie incl. HttpOnly); it is sent on the CONNECTION (conn.send),
 * then the list is filtered to the tab's origin by domain suffix match.
 * When the tab URL has no usable host (about:blank etc.) the unfiltered
 * list is returned.
 */
import type { ToolContext } from './index.js';
export declare function browser_cookies(args: Record<string, any>, ctx: ToolContext): Promise<string>;
