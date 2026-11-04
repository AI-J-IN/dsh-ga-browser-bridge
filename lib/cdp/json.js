/**
 * HTTP helpers for the Chrome DevTools Protocol HTTP endpoints (/json/*).
 *
 * All diagnostics go to stderr — never stdout — because this code runs under
 * MCP stdio where stdout is the protocol channel.
 *
 * Timeouts: every HTTP call respects `timeoutMs` (default 15000 ms).
 */
/** Default timeout for HTTP /json calls, in milliseconds. */
const DEFAULT_HTTP_TIMEOUT_MS = 15000;
/** Diagnostics are routed to stderr only (stdout is reserved for MCP). */
function log(msg) {
    process.stderr.write(`[cdp/json] ${msg}\n`);
}
/**
 * Error thrown when an HTTP /json request fails (non-2xx status or network
 * failure). Carries the offending URL and, when known, the HTTP status code.
 */
export class CdpHttpError extends Error {
    url;
    status;
    constructor(message, url, status) {
        super(message);
        this.url = url;
        this.status = status;
        this.name = "CdpHttpError";
    }
}
/**
 * GET a URL, parse the response body as JSON.
 *
 * Throws {@link CdpHttpError} on non-2xx status or on network failure
 * (including timeout). Uses the global `fetch` (Node >= 18).
 *
 * @param url - Absolute URL to fetch.
 * @param timeoutMs - Per-request timeout in ms (default 15000).
 * @returns The parsed JSON body.
 */
export async function fetchJson(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, method = "GET") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        try {
            response = await fetch(url, { method, signal: controller.signal });
        }
        catch (err) {
            const name = err?.name ?? "";
            const timedOut = name === "AbortError" ||
                /abort/i.test(name) ||
                /abort/i.test(String(err?.message ?? ""));
            if (timedOut) {
                throw new CdpHttpError(`timeout after ${timeoutMs}ms fetching ${url}`, url);
            }
            throw new CdpHttpError(`network error fetching ${url}: ${String(err?.message ?? err)}`, url);
        }
        if (!response.ok) {
            throw new CdpHttpError(`HTTP ${response.status} ${response.statusText} for ${url}`, url, response.status);
        }
        let text;
        try {
            text = await response.text();
        }
        catch (err) {
            throw new CdpHttpError(`failed to read body from ${url}: ${String(err?.message ?? err)}`, url, response.status);
        }
        if (text.length === 0) {
            // /json endpoints always answer JSON; an empty body is an error.
            throw new CdpHttpError(`empty response body from ${url}`, url, response.status);
        }
        try {
            return JSON.parse(text);
        }
        catch (err) {
            throw new CdpHttpError(`invalid JSON from ${url}: ${String(err?.message ?? err)}`, url, response.status);
        }
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Request a URL whose body is PLAIN TEXT and return it verbatim.
 *
 * `/json/activate/{id}` and `/json/close/{id}` answer with plain strings
 * ("Target activated" / "Target is closing"), NOT JSON — running them through
 * {@link fetchJson} threw `Unexpected token 'T'`. Those endpoints also require
 * the PUT verb on current Chrome.
 *
 * @param url - Absolute URL to fetch.
 * @param timeoutMs - Per-request timeout in ms (default 15000).
 * @param method - HTTP method (default GET; pass "PUT" for activate/close).
 * @returns The raw response body.
 */
export async function fetchText(url, timeoutMs = DEFAULT_HTTP_TIMEOUT_MS, method = "GET") {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        let response;
        try {
            response = await fetch(url, { method, signal: controller.signal });
        }
        catch (err) {
            const name = err?.name ?? "";
            const timedOut = name === "AbortError" ||
                /abort/i.test(name) ||
                /abort/i.test(String(err?.message ?? ""));
            if (timedOut) {
                throw new CdpHttpError(`timeout after ${timeoutMs}ms fetching ${url}`, url);
            }
            throw new CdpHttpError(`network error fetching ${url}: ${String(err?.message ?? err)}`, url);
        }
        if (!response.ok) {
            throw new CdpHttpError(`HTTP ${response.status} ${response.statusText} for ${url}`, url, response.status);
        }
        return await response.text();
    }
    finally {
        clearTimeout(timer);
    }
}
/** Build the base URL for the debug HTTP endpoints. */
function baseUrl(host, port) {
    return `http://${host}:${port}`;
}
/**
 * GET /json/version — browser metadata.
 *
 * @param host - Debug host (e.g. "127.0.0.1").
 * @param port - Debug port (e.g. 9222).
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns Parsed /json/version object (`Browser`, optional
 *   `webSocketDebuggerUrl`, plus any extra fields).
 */
export async function getVersion(host, port, timeoutMs) {
    return fetchJson(`${baseUrl(host, port)}/json/version`, timeoutMs);
}
/**
 * GET /json — list inspectable targets.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns Array of targets in /json order.
 */
export async function listTargets(host, port, timeoutMs) {
    const raw = await fetchJson(`${baseUrl(host, port)}/json`, timeoutMs);
    return (raw ?? []).map((t) => ({
        id: String(t.id ?? ""),
        type: String(t.type ?? ""),
        title: String(t.title ?? ""),
        url: String(t.url ?? ""),
        ...(typeof t.webSocketDebuggerUrl === "string"
            ? { webSocketDebuggerUrl: t.webSocketDebuggerUrl }
            : {}),
    }));
}
/**
 * PUT /json/new?url=... — open a new tab. Chrome >= 111 requires PUT; on a
 * 405 response the helper retries once with GET for older servers.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param url - URL to open in the new tab (optional; default about:blank).
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns The newly created target as reported by the endpoint.
 */
export async function newTab(host, port, url, timeoutMs) {
    const base = baseUrl(host, port);
    const endpoint = url !== undefined && url !== "" ? `/json/new?${encodeURIComponent(url)}` : "/json/new";
    const fullUrl = `${base}${endpoint}`;
    try {
        // Chrome >= 111 accepts ONLY PUT here. A GET answers 405 with
        // "Using unsafe HTTP verb GET to invoke /json/new" — and because the old
        // code's 405 fallback re-sent the same GET, creation hung forever.
        return await fetchJson(fullUrl, timeoutMs, "PUT");
    }
    catch (err) {
        if (err instanceof CdpHttpError && err.status === 405) {
            // Very old Chrome/Chromium honoured GET; retry with the real verb.
            log(`PUT /json/new got 405; falling back to GET ${endpoint}`);
            return fetchJson(fullUrl, timeoutMs, "GET");
        }
        throw err;
    }
}
/**
 * PUT /json/close/{id} — close a target.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param targetId - Target id to close.
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns True when the endpoint reported success ("Target is closing" /
 *   a truthy body); false when the target id is unknown.
 */
export async function closeTarget(host, port, targetId, timeoutMs) {
    const base = baseUrl(host, port);
    try {
        // These endpoints answer PLAIN TEXT ("Target is closing"), not JSON —
        // parsing them as JSON threw `Unexpected token 'T'`.
        const res = await fetchText(`${base}/json/close/${encodeURIComponent(targetId)}`, timeoutMs, "PUT");
        return res.length > 0;
    }
    catch (err) {
        // Chrome answers 404 for unknown target ids; treat as "not closed".
        if (err instanceof CdpHttpError && err.status === 404) {
            return false;
        }
        throw err;
    }
}
/**
 * PUT /json/activate/{id} — bring a target to the front.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param targetId - Target id to activate.
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns True on success; false when the target id is unknown.
 */
export async function activateTarget(host, port, targetId, timeoutMs) {
    const base = baseUrl(host, port);
    try {
        // Plain-text response ("Target activated"); see closeTarget.
        const res = await fetchText(`${base}/json/activate/${encodeURIComponent(targetId)}`, timeoutMs, "PUT");
        return res.length > 0;
    }
    catch (err) {
        if (err instanceof CdpHttpError && err.status === 404) {
            return false;
        }
        throw err;
    }
}
//# sourceMappingURL=json.js.map