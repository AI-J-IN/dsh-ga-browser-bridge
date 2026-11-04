import { noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, exceptionDetailsOf, evaluateValueOf } from './cdp.js';
import { routeTransport, browserScanViaExtension } from './extension-mode.js';
const READY_POLL_COUNT = 50; // 50 * 200ms = ~10s max wait
export async function browser_scan(args, ctx) {
    try {
        // DUAL MODE: connected extension wins; snapshot() carries text_only/maxchars.
        const route = await routeTransport(ctx);
        if (route.error !== undefined)
            return route.error;
        if (route.bridge)
            return await browserScanViaExtension(args, ctx, route.bridge);
        const conn = await ctx.getConnection();
        const tab = await resolveToolTab(conn, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        const session = await conn.attach(String(tab.id));
        try {
            const textOnly = boolArg(args?.text_only);
            const maxchars = intArg(args?.maxchars, 35000);
            const waitReady = `for (let i = 0; i < ${READY_POLL_COUNT} && document.readyState !== 'complete'; i++) ` +
                `await new Promise(r => setTimeout(r, 200));`;
            let expression;
            if (textOnly) {
                expression = `(async () => { ${waitReady} return document.body ? document.body.innerText : ''; })()`;
            }
            else {
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
            if (!textOnly && html.length > maxchars)
                html = html.slice(0, maxchars);
            return html || '(empty page)';
        }
        finally {
            await session.close();
        }
    }
    catch (e) {
        return unexpectedError(e);
    }
}
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
//# sourceMappingURL=scan.js.map