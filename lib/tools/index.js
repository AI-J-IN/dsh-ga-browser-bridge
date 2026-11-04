import { browser_tabs } from './tabs.js';
import { browser_scan } from './scan.js';
import { browser_execute_js } from './execute.js';
import { browser_cdp } from './cdp.js';
import { browser_cookies } from './cookies.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Loopback port the extension dials; override with DSH_BROWSER_EXT_PORT. */
const DEFAULT_EXTENSION_PORT = 18765;
/** Read a positive integer env override, else fall back to `dflt`. */
function portFromEnv(name, dflt) {
    const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
    if (raw === undefined || raw === '')
        return dflt;
    const n = Number.parseInt(String(raw), 10);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : dflt;
}
/**
 * Build a ToolContext. Tests inject a fake connection via overrides.
 * The default getConnection constructs a CdpConnection lazily and reuses it.
 *
 * The extension transport is constructed lazily too, and is STRICTLY optional:
 * if the extension module is missing (not built), or its loopback port cannot
 * be bound, `getExtensionBridge()` resolves to null and every tool falls back
 * to the CDP path. It must never throw during plugin mount — a user without
 * the extension installed still has to get a working CDP-only plugin.
 */
export function createToolContext(overrides) {
    let conn = null;
    let bridgePromise = null;
    /** Build (once) and start the extension bridge; null when unavailable. */
    const ensureBridge = async () => {
        if (!bridgePromise) {
            bridgePromise = (async () => {
                try {
                    // Never start the loopback listener for a caller that forced CDP or
                    // disabled the extension (port 0): it would only burn the port and
                    // make parallel test suites fight over 18765. Check before importing.
                    if (ctx.transport === 'cdp')
                        return null;
                    // Under jest every tool call would try to bind the real loopback
                    // port, so parallel suites produce dozens of EADDRINUSE warnings
                    // for a transport they are not testing. Opt in explicitly instead.
                    if (typeof process !== 'undefined' && process.env?.JEST_WORKER_ID)
                        return null;
                    const port = portFromEnv('DSH_BROWSER_EXT_PORT', DEFAULT_EXTENSION_PORT);
                    if (!Number.isInteger(port) || port <= 0)
                        return null;
                    // Dynamic import keeps this optional: a missing/partial extension
                    // build is a resolved null, not a module-load crash.
                    const mod = await import('../extension/index.js');
                    const bridge = new mod.ExtensionBridge({ port });
                    await bridge.start();
                    return bridge;
                }
                catch {
                    // PORT_IN_USE, BIND_FAILED, module-not-found, bad export — all mean
                    // "no extension transport available"; degrade to CDP silently.
                    return null;
                }
            })();
        }
        return bridgePromise;
    };
    const base = {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        currentTabId: undefined,
        autoLaunchChrome: true,
        transport: 'auto',
        getExtensionBridge: ensureBridge,
        getConnection: async () => {
            if (!conn) {
                const mod = await import('../cdp/index.js');
                // Read from the MERGED context (`ctx`), never from `base`: reading
                // `base` pinned every caller to 127.0.0.1:9222 and silently ignored
                // both the plugin config and DSH_BROWSER_PORT.
                conn = new mod.CdpConnection(ctx.host, ctx.port, {
                    timeoutMs: ctx.defaultTimeoutMs,
                    autoLaunch: ctx.autoLaunchChrome !== false,
                });
            }
            await conn.ensureOpen();
            return conn;
        },
        getOrCreateBrowser: async () => {
            // Compatibility entry: auto-launch now lives in the ensureOpen state
            // machine (CdpConnection options.autoLaunch). LaunchError still
            // propagates from ensureOpen; tool try/catch renders it as
            // "[error] LaunchError: <message>".
            const c = await ctx.getConnection();
            await c.ensureOpen();
        },
    };
    const ctx = { ...base, ...overrides };
    return ctx;
}
/**
 * Thrown by getOrCreateBrowser when Chrome could not be launched; the caller
 * returns its message to the MCP client (br_mcp.py: LaunchError -> message).
 */
export class BrowserLaunchError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LaunchError';
    }
}
export const TOOLS = {
    browser_tabs: {
        name: 'browser_tabs',
        description: "List/find/switch/create/close browser tabs (user's real browser, keeps login state). " +
            'action=list|find|switch|create|close. tab_id=tab id (see list). ' +
            'url_pattern or pattern for find. url/active for create.',
        inputSchema: {
            type: 'object',
            properties: {
                action: { type: 'string', description: 'list|find|switch|create|close' },
                tab_id: { type: 'string', description: 'target tab id' },
                url_pattern: { type: 'string', description: 'substring to match in URL (find)' },
                pattern: { type: 'string', description: 'alias of url_pattern (find)' },
                url: { type: 'string', description: 'url to open (create)' },
                active: { type: 'boolean', description: 'focus new tab (create)' },
            },
        },
        fn: browser_tabs,
    },
    browser_scan: {
        name: 'browser_scan',
        description: 'Get the current page as simplified HTML (script/style/noscript/svg elements removed). ' +
            'Prefer browser_execute_js for targeted reads. text_only=true returns visible text only.',
        inputSchema: {
            type: 'object',
            properties: {
                tab_id: { type: 'string', description: 'tab id (optional, defaults to current)' },
                text_only: { type: 'boolean', description: 'return innerText only' },
                maxchars: { type: 'integer', description: 'max chars, default 35000' },
            },
        },
        fn: browser_scan,
    },
    browser_execute_js: {
        name: 'browser_execute_js',
        description: 'Execute JS in the page for full browser control; returns the evaluated value; ' +
            'DOM-diff monitoring is not provided by this plugin. ' +
            'Use await with explicit return to get async values. ' +
            'Navigation+action must be split into two calls.',
        inputSchema: {
            type: 'object',
            properties: {
                script: { type: 'string', description: 'JavaScript to run' },
                tab_id: { type: 'string' },
                no_monitor: {
                    type: 'boolean',
                    description: 'accepted for compatibility; ignored (no DOM monitor in this plugin)',
                },
            },
            required: ['script'],
        },
        fn: browser_execute_js,
    },
    browser_cdp: {
        name: 'browser_cdp',
        description: 'Raw Chrome DevTools Protocol. Enables trusted input, file upload, screenshots, cross-origin iframe, ' +
            'shadow DOM. method e.g. Input.dispatchMouseEvent / DOM.setFileInputFiles / Page.captureScreenshot. ' +
            'Or pass commands=[...] for a batch ($N.x refs to prior results).',
        inputSchema: {
            type: 'object',
            properties: {
                tab_id: { type: 'string' },
                method: { type: 'string', description: 'CDP method' },
                params: { type: 'object', description: 'CDP params' },
                commands: {
                    type: 'array',
                    description: 'batch of {cmd,method,params,tabId}',
                    items: { type: 'object' },
                },
                timeout: { type: 'integer', description: 'seconds, default 30' },
            },
        },
        fn: browser_cdp,
    },
    browser_cookies: {
        name: 'browser_cookies',
        description: "Read cookies (incl. HttpOnly) for the tab's origin via CDP.",
        inputSchema: {
            type: 'object',
            properties: {
                tab_id: { type: 'string', description: 'tab id (optional, defaults to current)' },
            },
        },
        fn: browser_cookies,
    },
};
//# sourceMappingURL=index.js.map