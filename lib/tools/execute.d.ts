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
export declare function browser_execute_js(args: Record<string, any>, ctx: ToolContext): Promise<string>;
