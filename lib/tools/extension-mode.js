import { errPrefix, noBrowserError, unexpectedError } from './errors.js';
import { resolveTab, tabRow, resolveRefs, } from './cdp.js';
/** Log prefix for every diagnostic this module emits. */
const LOG_PREFIX = '[tools/extension-mode]';
/**
 * The single per-request budget the extension transport enforces, mirroring
 * EXTENSION_REQUEST_TIMEOUT_MS in src/extension/protocol.ts. Kept as a local
 * constant (rather than imported) so this module stays dependency-free of the
 * extension module — which may be absent at runtime. Used only for diagnostics.
 */
const EXTENSION_BUDGET_MS = 30_000;
/**
 * Diagnostic sink. stderr only — this module runs inside a host whose stdout
 * may be a protocol channel (DSH plugin / stdio MCP transport).
 */
function log(message) {
    try {
        process.stderr.write(`${LOG_PREFIX} ${message}\n`);
    }
    catch {
        // Nothing sensible to do if stderr is gone; never let logging break a tool.
    }
}
/**
 * One-shot flags so a degraded transport warns ONCE per process rather than on
 * every tool call (a model retrying a failing tool would otherwise flood the
 * host log). Module-scoped on purpose: the condition is a property of the
 * environment, not of a single ToolContext.
 */
const warned = new Set();
/** Emit `message` on stderr at most once per `key` for the process lifetime. */
function warnOnce(key, message) {
    if (warned.has(key))
        return;
    warned.add(key);
    log(message);
}
export async function routeTransport(ctx) {
    const mode = ctx.transport ?? 'auto';
    if (mode === 'cdp')
        return { bridge: null };
    const bridge = ctx.getExtensionBridge ? await ctx.getExtensionBridge() : null;
    if (bridge && safeIsConnected(bridge))
        return { bridge };
    // 'extension' with no usable bridge and 'auto' without one both mean
    // "the extension cannot serve this call" -> the existing CDP path.
    //
    // Forced mode is the surprising case: the caller explicitly asked for the
    // extension, so falling back silently would hide a real misconfiguration.
    // Warn once on stderr (never in the tool's return value — the model gets a
    // working result, and the warning is for the human reading host logs).
    if (mode === 'extension') {
        if (!bridge) {
            warnOnce('extension-transport-unavailable', 'transport is "extension" but no extension bridge is available ' +
                '(the MV3 extension is not installed, its module failed to load, or the ' +
                'loopback port could not be bound). Falling back to CDP. ' +
                'If you want the extension transport only, check the extension options page.');
        }
        else {
            warnOnce('extension-transport-disconnected', 'transport is "extension" but no extension is connected right now ' +
                '(the MV3 service worker may be asleep, or the browser restarted). ' +
                'Falling back to CDP. If you want the extension transport only, ' +
                'check the extension options page.');
        }
    }
    return { bridge: null };
}
/** `isConnected()` is a pure read, but never let a weird bridge break routing. */
function safeIsConnected(bridge) {
    try {
        return bridge.isConnected() === true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// Shared extension-side helpers
// ---------------------------------------------------------------------------
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
export async function resolveExtensionTab(bridge, explicitTabId, ctx) {
    const tabs = await listExtensionTabs(bridge);
    const view = { listTabs: async () => tabs };
    const hit = await resolveTab(view, explicitTabId, ctx.currentTabId);
    return hit ? toExtensionTab(hit) : null;
}
/** Find a tab by its exact id string; null when it is gone (stale/foreign id). */
export async function findTab(bridge, wanted) {
    const tabs = await listExtensionTabs(bridge);
    const hit = tabs.find((t) => String(t.id) === wanted);
    return hit ? toExtensionTab(hit) : null;
}
/**
 * Call one protocol method on the bridge.
 *
 * The real `ExtensionBridge` implements listTabs/evaluate/snapshot/sendCdp/
 * getCookies as thin wrappers over `request({method, params})`, so driving
 * `request` directly is behaviourally identical — and it lets tests (and any
 * proxy) observe traffic on a single seam. Bridges that only expose the
 * wrappers still work: we fall back to the wrapper method.
 */
async function bridgeRequest(bridge, method, params) {
    const req = bridge.request;
    if (typeof req === 'function') {
        return req.call(bridge, params === undefined ? { method } : { method, params });
    }
    throw new Error(`extension bridge cannot perform ${method}`);
}
/**
 * List tabs, normalizing to ExtensionTabLike[].
 *
 * Prefer the wrapper `bridge.listTabs()`: the real ExtensionBridge already
 * unwraps the wire envelope and runs normalizeTabs, so going through raw
 * `request({method:'tabs.list'})` hands back the envelope instead and trips
 * the "malformed tabs.list result" guard. Raw request is only a fallback for
 * bridges that do not expose the wrapper.
 */
async function listExtensionTabs(bridge) {
    let raw;
    if (typeof bridge.listTabs === 'function') {
        raw = await bridge.listTabs();
    }
    else if (typeof bridge.request === 'function') {
        raw = await bridgeRequest(bridge, 'tabs.list');
    }
    else {
        throw new Error('extension bridge cannot list tabs');
    }
    return normalizeExtensionTabs(raw);
}
/** Normalize one row (from the bridge or from resolveTab) into an ExtensionTab. */
function toExtensionTab(t) {
    return {
        id: Number(t?.id),
        title: t?.title ?? '',
        url: t?.url ?? '',
        active: t?.active === true,
        windowId: typeof t?.windowId === 'number' ? t.windowId : -1,
    };
}
/** Coerce a tabs.list reply into ExtensionTabLike[] (drops unusable rows). */
function normalizeExtensionTabs(result) {
    const list = Array.isArray(result)
        ? result
        : result && typeof result === 'object' && Array.isArray(result.tabs)
            ? result.tabs
            : null;
    if (list === null) {
        throw new Error('extension returned a malformed tabs.list result');
    }
    const tabs = [];
    for (const item of list) {
        const t = toExtensionTab(item);
        if (Number.isInteger(t.id) && t.id >= 0)
            tabs.push(t);
    }
    return tabs;
}
/** The {id,title,url} row the CDP path emits — same helper, same output. */
export function extensionTabRow(t) {
    return tabRow(t);
}
/** True when `s` is a usable chrome.tabs numeric id. */
export function asTabId(id) {
    const n = typeof id === 'number' ? id : Number(String(id ?? '').trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
}
// ---------------------------------------------------------------------------
// browser_tabs (extension)
// ---------------------------------------------------------------------------
const ACTIONS = 'list/find/switch/create/close';
/**
 * Extension twin of `browser_tabs`. Mirrors ../../tools/tabs.ts branch by
 * branch so that action strings, error strings and JSON shapes are identical.
 */
export async function browserTabsViaExtension(args, ctx, bridge) {
    try {
        const action = String(args?.action ?? 'list').toLowerCase();
        const tabs = await listExtensionTabs(bridge);
        if (action === 'list') {
            const rows = tabs.map(extensionTabRow);
            return JSON.stringify({ count: rows.length, tabs: rows });
        }
        if (action === 'find') {
            const pat = String(args?.url_pattern ?? args?.pattern ?? '');
            // Empty pattern matches every tab (br_mcp.py: `'' in url` is truthy).
            const rows = tabs
                .filter((t) => pat === '' || String(t.url ?? '').includes(pat))
                .map(extensionTabRow);
            return JSON.stringify({ matched: rows.length, tabs: rows });
        }
        if (action === 'switch') {
            const tid = args?.tab_id;
            if (tid === null || tid === undefined || String(tid) === '') {
                return errPrefix('switch needs tab_id');
            }
            const wanted = String(tid);
            const hit = tabs.find((t) => String(t.id) === wanted);
            if (!hit)
                return errPrefix(`tab not found: ${wanted}`);
            await sendTabOp(bridge, 'tabs.activate', hit.id);
            ctx.currentTabId = String(hit.id);
            return JSON.stringify(true);
        }
        if (action === 'close') {
            const tid = args?.tab_id;
            if (tid === null || tid === undefined || String(tid) === '') {
                return errPrefix('close needs tab_id');
            }
            const wanted = String(tid);
            const hit = tabs.find((t) => String(t.id) === wanted);
            if (!hit)
                return errPrefix(`tab not found: ${wanted}`);
            await sendTabOp(bridge, 'tabs.close', hit.id);
            if (ctx.currentTabId === String(hit.id))
                ctx.currentTabId = undefined;
            return JSON.stringify(true);
        }
        if (action === 'create') {
            // create works with zero existing tabs, like the CDP path.
            const url = args?.url ?? 'about:blank';
            const active = boolArg(args?.active);
            const created = await createTab(bridge, url, active);
            const after = await listExtensionTabs(bridge);
            const row = created !== null ? after.find((t) => String(t.id) === String(created)) : undefined;
            if (row) {
                if (active)
                    ctx.currentTabId = String(row.id);
                return JSON.stringify(extensionTabRow(row));
            }
            // No listing row: fall back to the minimal {id, url} shape the CDP
            // path uses when the connection does not re-list the new target.
            const id = created !== null ? String(created) : '';
            if (active && id !== '')
                ctx.currentTabId = id;
            return JSON.stringify({ id, title: '', url });
        }
        return errPrefix(`unknown action: ${action} (${ACTIONS})`);
        // NOTE: list/find above are deliberately NOT gated on "at least one tab",
        // because a connected extension with zero tabs must report {count:0,...}
        // rather than the CDP path's no-browser string (which talks about port
        // 9222 and would mislead the model in extension mode).
    }
    catch (e) {
        return unexpectedError(e);
    }
}
/**
 * Run a tabs.* protocol method (activate/close). Both are plain protocol
 * methods on the bridge; `request` is the single seam they share.
 */
async function sendTabOp(bridge, method, tabId) {
    await bridgeRequest(bridge, method, { tabId });
}
/** Create a tab and return its chrome.tabs id (or null when unaddressed). */
async function createTab(bridge, url, active) {
    const res = await bridgeRequest(bridge, 'tabs.create', { url, active });
    return asTabId(res?.id ?? res?.tabId ?? res?.tab?.id);
}
// ---------------------------------------------------------------------------
// browser_scan (extension)
// ---------------------------------------------------------------------------
/** Extension twin of `browser_scan`: snapshot, honour text_only/maxchars. */
export async function browserScanViaExtension(args, ctx, bridge) {
    try {
        const tab = await resolveExtensionTab(bridge, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        const textOnly = boolArg(args?.text_only);
        const maxchars = intArg(args?.maxchars, 35000);
        const snap = await snapshotViaBridge(bridge, { tabId: tab.id, textOnly, maxchars });
        // The extension already applies maxchars, but its snapshot is allowed to
        // be generous; the CDP path cuts unconditionally for the HTML case, so do
        // the same to keep output length identical between transports.
        let content = String(snap?.content ?? '');
        if (content.length > maxchars)
            content = content.slice(0, maxchars);
        return content || '(empty page)';
    }
    catch (e) {
        return unexpectedError(e);
    }
}
/** Snapshot through the bridge, preferring the request seam. */
async function snapshotViaBridge(bridge, p) {
    if (typeof bridge.request === 'function') {
        const raw = await bridgeRequest(bridge, 'page.snapshot', { ...p });
        if (raw && typeof raw === 'object' && typeof raw.content === 'string') {
            return {
                content: raw.content,
                truncated: raw.truncated === true,
                title: typeof raw.title === 'string' ? raw.title : '',
                url: typeof raw.url === 'string' ? raw.url : '',
            };
        }
        throw new Error('extension returned a malformed page.snapshot result');
    }
    return bridge.snapshot(p);
}
// ---------------------------------------------------------------------------
// browser_execute_js (extension)
// ---------------------------------------------------------------------------
/** Extension twin of `browser_execute_js`. */
export async function browserExecuteJsViaExtension(args, ctx, bridge) {
    try {
        const script = args?.script;
        if (typeof script !== 'string' || script.trim() === '') {
            return errPrefix('empty script');
        }
        const tab = await resolveExtensionTab(bridge, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        // The bridge unwraps the EvaluateResult envelope for us: it returns the
        // `value`, and throws (code PAGE_ERROR) when the page threw, carrying the
        // exception text as `detail`. Both halves must render exactly like the
        // CDP path's exceptionDetails branch: "[error] " + exception text.
        try {
            const value = await evaluateViaBridge(bridge, {
                tabId: tab.id,
                expression: script,
                awaitPromise: true,
                returnByValue: true,
            });
            return JSON.stringify({ result: value });
        }
        catch (e) {
            const pageError = pageErrorText(e);
            if (pageError !== null)
                return errPrefix(JSON.stringify(pageError));
            throw e;
        }
    }
    catch (e) {
        return unexpectedError(e);
    }
}
/**
 * Evaluate through the bridge, preferring the request seam. Unwraps the
 * EvaluateResult envelope and converts a page throw into the PAGE_ERROR-shaped
 * exception object `pageErrorText` understands, so the tool renders it exactly
 * like the CDP path's exceptionDetails branch.
 */
async function evaluateViaBridge(bridge, p) {
    if (typeof bridge.request !== 'function') {
        return bridge.evaluate(p);
    }
    const raw = await bridgeRequest(bridge, 'page.evaluate', { ...p });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        if (typeof raw.exception === 'string' && raw.exception !== '') {
            const err = new Error(`The page threw while evaluating the expression: ${raw.exception}`);
            err.name = 'ExtensionBridgeError';
            err.code = 'PAGE_ERROR';
            err.detail = raw.exception;
            throw err;
        }
        return 'value' in raw ? raw.value : raw;
    }
    return raw;
}
/**
 * Extract the page exception text from an ExtensionBridgeError('PAGE_ERROR').
 * Returns null for any other error (those belong to unexpectedError()).
 */
function pageErrorText(e) {
    if (!(e instanceof Error))
        return null;
    const anyErr = e;
    if (anyErr.code !== 'PAGE_ERROR')
        return null;
    if (typeof anyErr.detail === 'string' && anyErr.detail !== '')
        return anyErr.detail;
    // Detail missing: fall back to the message, without the bridge's prose
    // prefix, so the tool still reports the raw exception.
    const marker = 'while evaluating the expression: ';
    const i = anyErr.message.indexOf(marker);
    return i >= 0 ? anyErr.message.slice(i + marker.length) : anyErr.message;
}
/** Extension twin of `browser_cdp` (single + batch). */
export async function browserCdpViaExtension(args, ctx, bridge) {
    try {
        const commands = args?.commands;
        if (Array.isArray(commands) && commands.length > 0) {
            return await runExtensionBatch(ctx, bridge, commands);
        }
        const method = args?.method;
        if (!method || String(method).trim() === '') {
            return errPrefix('need method or commands');
        }
        const tab = await resolveExtensionTab(bridge, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        const res = await sendCdpViaBridge(bridge, {
            tabId: tab.id,
            method: String(method),
            params: (args?.params ?? {}),
        });
        return JSON.stringify(res);
    }
    catch (e) {
        return unexpectedError(e);
    }
}
/** Send one CDP command, preferring the request seam. */
async function sendCdpViaBridge(bridge, p) {
    if (typeof bridge.request === 'function') {
        return bridgeRequest(bridge, 'cdp.send', {
            tabId: p.tabId,
            method: p.method,
            params: p.params ?? {},
        });
    }
    return bridge.sendCdp(p);
}
/**
 * Batch runner mirroring cdp.ts `runBatch`: per-command tabId wins, otherwise
 * the shared resolution (tab_id -> currentTabId -> first); "$N.path" refs are
 * resolved by the SAME `resolveRefs` helper, over an identical priorResults
 * array.
 *
 * PER-COMMAND `timeout` IS EXPLICITLY IGNORED ON THIS TRANSPORT.
 * `chrome.debugger` has no per-command timeout concept: the extension answers
 * over one socket request, and every request is bounded by the bridge's
 * single budget (EXTENSION_REQUEST_TIMEOUT_MS, 30s). So a `cmd.timeout` cannot
 * be honoured here — and it is deliberately NOT an error either (the CDP path
 * would accept it, and the batch is otherwise identical). When a command asks
 * for something clearly shorter than that budget, we say so once on stderr;
 * the tool return value is unaffected.
 */
async function runExtensionBatch(ctx, bridge, commands) {
    const priorResults = [];
    // Warn (once) if the caller is relying on a per-command budget we cannot
    // apply. Threshold: anything meaningfully below the 30s extension budget.
    const ignored = commands
        .map((c) => c?.timeout)
        .filter((t) => typeof t === 'number' && t > 0 && t * 1000 < EXTENSION_BUDGET_MS);
    if (ignored.length > 0) {
        warnOnce('extension-batch-per-command-timeout', `${ignored.length} command(s) set a per-command "timeout" (${ignored.join(', ')}s) but the extension transport applies one ${EXTENSION_BUDGET_MS / 1000}s budget to ` +
            'every request (chrome.debugger has no per-command timeout). Those values are ignored; ' +
            'the batch still runs normally. Use transport "cdp" if you need per-command budgets.');
    }
    // Resolve the shared default tab once, exactly like the CDP runner resolves
    // it per command; the tab list does not change mid-batch in practice, and
    // one call keeps extension round-trips down.
    const defaultTab = await resolveExtensionTab(bridge, undefined, ctx);
    for (const cmd of commands) {
        const method = cmd?.method;
        if (!method || String(method).trim() === '') {
            priorResults.push(errPrefix('need method or commands'));
            continue;
        }
        const tab = cmd?.tabId !== undefined && cmd?.tabId !== null
            ? await resolveExtensionTab(bridge, cmd.tabId, ctx)
            : defaultTab;
        if (!tab) {
            priorResults.push(noBrowserError());
            continue;
        }
        // Reuse the CDP path's ref resolver verbatim — same regex, same ".result"
        // fallback, so a batch behaves identically on both transports.
        const params = resolveRefs(cmd?.params ?? {}, priorResults);
        try {
            const res = await sendCdpViaBridge(bridge, { tabId: tab.id, method: String(method), params });
            priorResults.push(res);
        }
        catch (e) {
            priorResults.push(unexpectedError(e));
        }
    }
    return JSON.stringify(priorResults);
}
// ---------------------------------------------------------------------------
// browser_cookies (extension)
// ---------------------------------------------------------------------------
/** Extension twin of `browser_cookies`. */
export async function browserCookiesViaExtension(args, ctx, bridge) {
    try {
        const tab = await resolveExtensionTab(bridge, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        const url = typeof tab.url === 'string' && tab.url !== '' ? tab.url : undefined;
        const all = await getCookiesViaBridge(bridge, url === undefined ? { all: true } : { url });
        const cookies = Array.isArray(all) ? all : [];
        return JSON.stringify({ cookies });
    }
    catch (e) {
        return unexpectedError(e);
    }
}
/** Read cookies, preferring the request seam. */
async function getCookiesViaBridge(bridge, p) {
    if (typeof bridge.request !== 'function') {
        return bridge.getCookies(p);
    }
    const raw = await bridgeRequest(bridge, 'cookies.get', { ...p });
    if (Array.isArray(raw))
        return raw;
    if (raw && typeof raw === 'object' && Array.isArray(raw.cookies))
        return raw.cookies;
    return [];
}
// ---------------------------------------------------------------------------
// Arg coercion (identical semantics to the CDP tools' local helpers)
// ---------------------------------------------------------------------------
function boolArg(v) {
    if (v === undefined || v === null)
        return false;
    if (typeof v === 'boolean')
        return v;
    if (typeof v === 'string')
        return v.trim().toLowerCase() === 'true';
    return Boolean(v);
}
function intArg(v, dflt) {
    if (v === undefined || v === null || v === '')
        return dflt;
    const n = typeof v === 'number' ? v : parseInt(String(v), 10);
    return Number.isFinite(n) ? n : dflt;
}
//# sourceMappingURL=extension-mode.js.map