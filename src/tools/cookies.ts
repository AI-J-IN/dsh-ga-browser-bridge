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
import { noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, unwrap } from './cdp.js';

export async function browser_cookies(
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<string> {
  try {
    const conn = await ctx.getConnection();
    const tab = await resolveToolTab(conn, args?.tab_id, ctx);
    if (!tab) return noBrowserError();

    const res = await conn.send('Network.getAllCookies');
    const all: any[] = unwrap(res, 'cookies') ?? [];
    const host = hostOf(tab.url);
    const cookies = host ? all.filter((c) => domainMatches(c?.domain, host)) : all;
    return JSON.stringify({ cookies });
  } catch (e) {
    return unexpectedError(e);
  }
}

function hostOf(url: unknown): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    // Not an absolute URL (about:blank etc.) — no host to filter on.
    return null;
  }
}

/** Suffix match: cookie domain ".example.com" matches host "a.example.com". */
function domainMatches(cookieDomain: unknown, host: string): boolean {
  if (typeof cookieDomain !== 'string' || cookieDomain === '') return false;
  const d = cookieDomain.toLowerCase().replace(/^\./, '');
  return host === d || host.endsWith('.' + d);
}
