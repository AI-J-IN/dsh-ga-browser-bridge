// dsh-ga-browser-bridge — DSH native plugin entry.
//
// Registers the five browser_* tools (browser_tabs / browser_scan /
// browser_execute_js / browser_cdp / browser_cookies) as native Cordis tools
// via ctx.tools.register. The tools talk CDP directly to the user's real
// Chrome (default 127.0.0.1:9222); no GA, no Python, no browser extension.
//
// Tool semantics (names, parameter names, tab_id defaulting, error strings)
// are byte-compatible with the legacy ga-browser-bridge MCP bridge
// (br_mcp.py) so existing prompts and agent memories keep working.
import { TOOLS, createToolContext } from './tools/index.js';
export const name = 'ga-browser-bridge';
export const inject = ['tools'];
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
/** Render a tool result for DSH: plain text content block. */
const stringOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: value }],
};
/** Map our ToolSpec (br_mcp.py-shaped) onto ctx.tools.register's shape. */
function toRegisteredTool(spec) {
    return {
        name: spec.name,
        description: spec.description,
        parameters: spec.inputSchema,
        output: stringOutput,
        async execute(args, _exec) {
            const toolCtx = context;
            if (!toolCtx) {
                return '[error] plugin context not initialized (missing ToolContext)';
            }
            try {
                return await spec.fn(args, toolCtx);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return `[error] ${error instanceof Error ? error.constructor.name : 'Error'}: ${message}`;
            }
        },
    };
}
/** Single tool context per plugin mount (module-scoped, set by apply). */
let context;
export function apply(ctx, rawConfig) {
    // The cordis loader passes `null` for an entry mounted without an explicit
    // `config:` key — the default parameter only covers `undefined`, so a null
    // here used to throw "Cannot read properties of null (reading 'host')" and
    // the whole plugin failed to activate. Coalesce instead.
    const config = rawConfig ?? {};
    const host = typeof config.host === 'string' && config.host ? config.host : DEFAULT_HOST;
    const port = typeof config.port === 'number' ? config.port : DEFAULT_PORT;
    context = createToolContext({
        host,
        port,
        autoLaunchChrome: config.autoLaunchChrome !== false,
    });
    const disposers = [];
    for (const spec of Object.values(TOOLS)) {
        disposers.push(ctx.tools.register(toRegisteredTool(spec)));
    }
    ctx.effect(() => () => {
        disposers.splice(0).forEach((dispose) => {
            try {
                dispose();
            }
            catch {
                // best-effort teardown
            }
        });
        context = undefined;
    }, 'ga-browser-bridge: tools');
}
//# sourceMappingURL=plugin.js.map