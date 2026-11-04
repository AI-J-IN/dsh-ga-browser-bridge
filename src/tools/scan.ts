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
import { noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, exceptionDetailsOf, evaluateValueOf } from './cdp.js';

const READY_POLL_COUNT = 50; // 50 * 200ms = ~10s max wait

export async function browser_scan(
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<string> {
  try {
    const conn = await ctx.getConnection();
    const tab = await resolveToolTab(conn, args?.tab_id, ctx);
    if (!tab) return noBrowserError();

    const session = await conn.attach(String(tab.id));
    try {
      const textOnly = boolArg(args?.text_only);
      const maxchars = intArg(args?.maxchars, 35000);

      const waitReady =
        `for (let i = 0; i < ${READY_POLL_COUNT} && document.readyState !== 'complete'; i++) ` +
        `await new Promise(r => setTimeout(r, 200));`;

      let expression: string;
      if (textOnly) {
        expression = `(async () => { ${waitReady} return document.body ? document.body.innerText : ''; })()`;
      } else {
        expression =
          `(async () => { ${waitReady} ` +
          `const c = document.documentElement.cloneNode(true); ` +
          `c.querySelectorAll('script,style,noscript,svg').forEach(e=>e.remove()); ` +
          `return c.outerHTML; })()`;
      }

      const res = await session.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = exceptionDetailsOf(res);
      if (ex) {
        throw new Error(`page evaluation failed: ${JSON.stringify(ex)}`);
      }

      let html = String(evaluateValueOf(res) ?? '');
      if (!textOnly && html.length > maxchars) html = html.slice(0, maxchars);
      return html || '(empty page)';
    } finally {
      await session.close();
    }
  } catch (e) {
    return unexpectedError(e);
  }
}

function boolArg(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return Boolean(v);
}

function intArg(v: unknown, dflt: number): number {
  if (v === undefined || v === null || v === '') return dflt;
  const n = typeof v === 'number' ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : dflt;
}
