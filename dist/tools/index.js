import { browser_tabs } from './tabs.js';
import { browser_scan } from './scan.js';
import { browser_execute_js } from './execute.js';
import { browser_cdp } from './cdp.js';
import { browser_cookies } from './cookies.js';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_TIMEOUT_MS = 30_000;
/**
 * Build a ToolContext. Tests inject a fake connection via overrides.
 * The default getConnection constructs a CdpConnection lazily and reuses it.
 */
export function createToolContext(overrides) {
    let conn = null;
    const base = {
        host: DEFAULT_HOST,
        port: DEFAULT_PORT,
        defaultTimeoutMs: DEFAULT_TIMEOUT_MS,
        currentTabId: undefined,
        autoLaunchChrome: true,
        getConnection: async () => {
            if (!conn) {
                const mod = await import('../cdp/index.js');
                conn = new mod.CdpConnection(base.host, base.port, {
                    timeoutMs: base.defaultTimeoutMs,
                    autoLaunch: base.autoLaunchChrome !== false,
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
            const c = await base.getConnection();
            await c.ensureOpen();
        },
    };
    return { ...base, ...overrides };
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