import { errPrefix, noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, exceptionDetailsOf, evaluateValueOf } from './cdp.js';
import { routeTransport, browserExecuteJsViaExtension } from './extension-mode.js';
export async function browser_execute_js(args, ctx) {
    try {
        const script = args?.script;
        if (typeof script !== 'string' || script.trim() === '') {
            return errPrefix('empty script');
        }
        // DUAL MODE: connected extension wins; a PAGE_ERROR from the bridge is
        // rendered as "[error] <exception text>", like the exceptionDetails path.
        const route = await routeTransport(ctx);
        if (route.error !== undefined)
            return route.error;
        if (route.bridge)
            return await browserExecuteJsViaExtension(args, ctx, route.bridge);
        const conn = await ctx.getConnection();
        const tab = await resolveToolTab(conn, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
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
        }
        finally {
            await session.close();
        }
    }
    catch (e) {
        return unexpectedError(e);
    }
}
function exceptionText(details) {
    if (typeof details === 'string')
        return details;
    if (details?.exception?.description)
        return details.exception.description;
    if (details?.text)
        return details.text;
    return String(details);
}
//# sourceMappingURL=execute.js.map