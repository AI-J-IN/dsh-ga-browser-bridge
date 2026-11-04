import { noBrowserError, unexpectedError } from './errors.js';
import { resolveToolTab, unwrap } from './cdp.js';
export async function browser_cookies(args, ctx) {
    try {
        const conn = await ctx.getConnection();
        const tab = await resolveToolTab(conn, args?.tab_id, ctx);
        if (!tab)
            return noBrowserError();
        // Chrome 155 REMOVED Network.getAllCookies / Network.getCookies at the
        // browser level — the CDP docs point at Storage.getCookies instead, and
        // older builds answer "'Network.getAllCookies' wasn't found" (code
        // -32601). Try the current API first, fall back for older Chrome.
        let res;
        try {
            res = await conn.send('Storage.getCookies');
        }
        catch {
            res = await conn.send('Network.getAllCookies');
        }
        const all = unwrap(res, 'cookies') ?? [];
        const host = hostOf(tab.url);
        const cookies = host ? all.filter((c) => domainMatches(c?.domain, host)) : all;
        return JSON.stringify({ cookies });
    }
    catch (e) {
        return unexpectedError(e);
    }
}
function hostOf(url) {
    if (typeof url !== 'string' || url === '')
        return null;
    try {
        return new URL(url).hostname.toLowerCase();
    }
    catch {
        // Not an absolute URL (about:blank etc.) — no host to filter on.
        return null;
    }
}
/** Suffix match: cookie domain ".example.com" matches host "a.example.com". */
function domainMatches(cookieDomain, host) {
    if (typeof cookieDomain !== 'string' || cookieDomain === '')
        return false;
    const d = cookieDomain.toLowerCase().replace(/^\./, '');
    return host === d || host.endsWith('.' + d);
}
//# sourceMappingURL=cookies.js.map