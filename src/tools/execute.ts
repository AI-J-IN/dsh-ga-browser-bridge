/**
 * browser_execute_js — evaluate JS in the page via Runtime.evaluate.
 *
 * br_mcp.py parity:
 *  - script required, else "[error] empty script"
 *  - tab_id optional (defaults like _cur_tab: explicit -> current -> first)
 *  - no_monitor accepted for compatibility but ignored (this plugin has no
 *    DOM monitor; documented in the tool description)
 *  - awaitPromise:true so `return await ...` works; returnByValue:true so
 *    the value crosses the CDP boundary
 *  - exceptionDetails -> "[error] " + JSON of the exception text
 *  - success -> JSON of {result: value}
 *    (br_mcp.py appended DOM diff + transient texts from simphtml; those
 *    cannot be reproduced over plain CDP — see the tool description)
 */
import type { ToolContext } from './index.js';
import { errPrefix, noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, exceptionDetailsOf, evaluateValueOf } from './cdp.js';
import { routeTransport, browserExecuteJsViaExtension } from './extension-mode.js';

export async function browser_execute_js(
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<string> {
  try {
    const script = args?.script;
    if (typeof script !== 'string' || script.trim() === '') {
      return errPrefix('empty script');
    }

    // DUAL MODE: connected extension wins; a PAGE_ERROR from the bridge is
    // rendered as "[error] <exception text>", like the exceptionDetails path.
    const route = await routeTransport(ctx);
    if (route.error !== undefined) return route.error;
    if (route.bridge) return await browserExecuteJsViaExtension(args, ctx, route.bridge);

    const conn = await ctx.getConnection();
    const tab = await resolveToolTab(conn, args?.tab_id, ctx);
    if (!tab) return noBrowserError();

    const session = await conn.attach(String(tab.id));
    try {
      const res = await session.send('Runtime.evaluate', {
        expression: script,
        awaitPromise: true,
        returnByValue: true,
      });
      const ex = exceptionDetailsOf(res);
      if (ex) {
        return errPrefix(JSON.stringify(exceptionText(ex)));
      }
      return JSON.stringify({ result: evaluateValueOf(res) });
    } finally {
      await session.close();
    }
  } catch (e) {
    return unexpectedError(e);
  }
}

function exceptionText(details: any): string {
  if (typeof details === 'string') return details;
  if (details?.exception?.description) return details.exception.description;
  if (details?.text) return details.text;
  return String(details);
}
