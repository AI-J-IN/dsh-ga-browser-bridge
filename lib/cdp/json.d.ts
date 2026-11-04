/**
 * HTTP helpers for the Chrome DevTools Protocol HTTP endpoints (/json/*).
 *
 * All diagnostics go to stderr — never stdout — because this code runs under
 * MCP stdio where stdout is the protocol channel.
 *
 * Timeouts: every HTTP call respects `timeoutMs` (default 15000 ms).
 */
import { CdpTarget } from "./types.js";
/**
 * Error thrown when an HTTP /json request fails (non-2xx status or network
 * failure). Carries the offending URL and, when known, the HTTP status code.
 */
export declare class CdpHttpError extends Error {
    readonly url: string;
    readonly status?: number | undefined;
    constructor(message: string, url: string, status?: number | undefined);
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
export declare function fetchJson<T = any>(url: string, timeoutMs?: number, method?: string): Promise<T>;
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
export declare function fetchText(url: string, timeoutMs?: number, method?: string): Promise<string>;
/**
 * GET /json/version — browser metadata.
 *
 * @param host - Debug host (e.g. "127.0.0.1").
 * @param port - Debug port (e.g. 9222).
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns Parsed /json/version object (`Browser`, optional
 *   `webSocketDebuggerUrl`, plus any extra fields).
 */
export declare function getVersion(host: string, port: number, timeoutMs?: number): Promise<{
    Browser: string;
    webSocketDebuggerUrl?: string;
    [k: string]: any;
}>;
/**
 * GET /json — list inspectable targets.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns Array of targets in /json order.
 */
export declare function listTargets(host: string, port: number, timeoutMs?: number): Promise<CdpTarget[]>;
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
export declare function newTab(host: string, port: number, url?: string, timeoutMs?: number): Promise<CdpTarget>;
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
export declare function closeTarget(host: string, port: number, targetId: string, timeoutMs?: number): Promise<boolean>;
/**
 * PUT /json/activate/{id} — bring a target to the front.
 *
 * @param host - Debug host.
 * @param port - Debug port.
 * @param targetId - Target id to activate.
 * @param timeoutMs - Request timeout in ms (default 15000).
 * @returns True on success; false when the target id is unknown.
 */
export declare function activateTarget(host: string, port: number, targetId: string, timeoutMs?: number): Promise<boolean>;
