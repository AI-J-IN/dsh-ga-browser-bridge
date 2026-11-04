/**
 * browser_scan — get the current page as (simplified) HTML or visible text.
 *
 * br_mcp.py parity:
 *  - tool_scan(): ensure tabs exist (_need_browser), select tab (explicit
 *    tab_id -> default/current -> first), read simplified HTML, text_only ->
 *    innerText, cut to maxchars (default 35000), return html or "(empty page)".
 *
 * CDP has no simphtml filter, so "simplified" is approximated by cloning
 * documentElement and stripping script/style/noscript/svg elements, then
 * slicing to maxchars.
 *
 * Readiness: instead of a separate Runtime.evaluate poll (which would put a
 * probe call ahead of the payload call on the wire), the wait is folded into
 * the payload expression itself — an async IIFE that polls document.readyState
 * inside the page (max ~10s) before producing the value, evaluated with
 * awaitPromise:true.
 */
import type { ToolContext } from './index.js';
export declare function browser_scan(args: Record<string, any>, ctx: ToolContext): Promise<string>;
