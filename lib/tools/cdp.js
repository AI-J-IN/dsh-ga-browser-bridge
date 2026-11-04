import { errPrefix, noBrowserError, unexpectedError } from './errors.js';
import { routeTransport, browserCdpViaExtension } from './extension-mode.js';
// ---------------------------------------------------------------------------
// Tab resolution (br_mcp.py _select()/_cur_tab() order)
// ---------------------------------------------------------------------------
/** Normalize a tab id argument: null/""/"0" -> null (use default). */
export function normalizeTabId(tabId) {
    if (tabId === null || tabId === undefined)
        return null;
    const s = String(tabId).trim();
    if (s === '' || s === '0')
        return null;
    return s;
}
/**
 * Resolve the target tab: explicit id -> ctx.currentTabId -> first tab.
 * Returns the tab object or null when there are no tabs.
 */
export async function resolveTab(conn, explicitTabId, currentTabId) {
    const tabs = await conn.listTabs();
    if (!tabs || tabs.length === 0)
        return null;
    const wanted = normalizeTabId(explicitTabId);
    if (wanted !== null) {
        const hit = tabs.find((t) => String(t.id) === wanted);
        if (hit)
            return hit;
    }
    if (currentTabId) {
        const hit = tabs.find((t) => String(t.id) === String(currentTabId));
        if (hit)
            return hit;
    }
    return tabs[0];
}
/** Resolve with the context default (explicit arg -> currentTabId -> first). */
export async function resolveToolTab(conn, explicitTabId, ctx) {
    return resolveTab(conn, explicitTabId, ctx.currentTabId);
}
/** The no-browser error string (br_mcp.py _need_browser()). */
export function noBrowser() {
    return noBrowserError();
}
/** Format a target as the {id,title,url} row br_mcp.py returned. */
export function tabRow(t) {
    return { id: String(t.id), title: t.title ?? '', url: t.url ?? '' };
}
// ---------------------------------------------------------------------------
// Response-shape helpers (accept raw envelope or unwrapped payload)
// ---------------------------------------------------------------------------
/**
 * Read `key` from res, tolerating both the unwrapped payload (real
 * connection: {cookies: [...]}) and the raw wire envelope (test fake:
 * {result: {result: {value}}} — CDP wraps the payload in a "result" field,
 * and the fake does not unwrap it). Searches res, res.result, and
 * res.result.result.
 */
export function unwrap(res, key) {
    let cur = res;
    for (let depth = 0; cur && typeof cur === 'object' && depth < 3; depth++) {
        if (key in cur)
            return cur[key];
        cur = cur.result;
    }
    return undefined;
}
/** exceptionDetails from any of the accepted shapes. */
export function exceptionDetailsOf(res) {
    return unwrap(res, 'exceptionDetails');
}
/** Evaluated value from any of the accepted shapes. */
export function evaluateValueOf(res) {
    return unwrap(res, 'value');
}
// ---------------------------------------------------------------------------
// browser_cdp tool
// ---------------------------------------------------------------------------
const REF_RE = /^\$(\d+)\.(.+)$/;
export async function browser_cdp(args, ctx) {
    try {
        const commands = args?.commands;
        if (!(Array.isArray(commands) && commands.length > 0)) {
            const method = args?.method;
            if (!method || String(method).trim() === '') {
                return errPrefix('need method or commands');
            }
        }
        // DUAL MODE: connected extension wins for both single and batch; the
        // extension runner reuses this file's resolveRefs for "$N.path" refs.
        const route = await routeTransport(ctx);
        if (route.error !== undefined)
            return route.error;
        if (route.bridge)
            return await browserCdpViaExtension(args, ctx, route.bridge);
        if (Array.isArray(commands) && commands.length > 0) {
            return await runBatch(ctx, commands, intArg(args?.timeout, 30));
        }
        const method = args?.method;
        const conn = await ctx.getConnection();
        const tab = await resolveToolTab(conn, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        const session = await conn.attach(String(tab.id));
        try {
            const res = await session.send(String(method), args?.params ?? {}, intArg(args?.timeout, 30) * 1000);
            return JSON.stringify(res);
        }
        finally {
            await session.close();
        }
    }
    catch (e) {
        return unexpectedError(e);
    }
}
async function runBatch(ctx, commands, defaultTimeoutSec) {
    const priorResults = [];
    const conn = await ctx.getConnection();
    for (const cmd of commands) {
        const method = cmd?.method;
        if (!method || String(method).trim() === '') {
            priorResults.push(errPrefix('need method or commands'));
            continue;
        }
        // Per-command tabId wins; otherwise the batch shares the single-call
        // resolution (tool-level tab_id -> ctx.currentTabId -> first tab).
        const tab = await resolveTab(conn, cmd?.tabId !== undefined ? cmd.tabId : undefined, ctx.currentTabId);
        if (!tab) {
            priorResults.push(noBrowserError());
            continue;
        }
        const params = resolveRefs(cmd?.params ?? {}, priorResults);
        const timeoutMs = intArg(cmd?.timeout, defaultTimeoutSec) * 1000;
        const session = await conn.attach(String(tab.id));
        try {
            const res = await session.send(String(method), params, timeoutMs);
            priorResults.push(res);
        }
        catch (e) {
            priorResults.push(unexpectedError(e));
        }
        finally {
            await session.close();
        }
    }
    return JSON.stringify(priorResults);
}
/**
 * Deep-resolve "$N.path" string references against priorResults (N is the
 * 0-based command index; br_mcp.py: "$N.x refs to prior results"). Each
 * lookup tries the raw result and its .result envelope.
 */
export function resolveRefs(value, prior) {
    if (typeof value === 'string') {
        const m = REF_RE.exec(value);
        if (m) {
            const idx = parseInt(m[1], 10);
            const path = m[2];
            return resolveRef(prior[idx], path);
        }
        return value;
    }
    if (Array.isArray(value)) {
        return value.map((v) => resolveRefs(v, prior));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = resolveRefs(v, prior);
        }
        return out;
    }
    return value;
}
function resolveRef(base, path) {
    for (const root of [base, base?.result]) {
        let cur = root;
        for (const part of path.split('.')) {
            if (cur === null || cur === undefined) {
                cur = undefined;
                break;
            }
            cur = cur[part];
        }
        if (cur !== undefined)
            return cur;
    }
    return undefined;
}
function intArg(v, dflt) {
    if (v === undefined || v === null || v === '')
        return dflt;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : dflt;
}
//# sourceMappingURL=cdp.js.map