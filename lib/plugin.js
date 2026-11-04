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
import { createRequire } from 'node:module';
import { TOOLS, createToolContext } from './tools/index.js';
export const name = 'ga-browser-bridge';
export const inject = ['tools'];
/**
 * Config schema for the cordis loader and the DSH settings UI.
 *
 * Declaring a schema matters for two reasons:
 *  1. The loader validates/coerces the row's `config` and fills defaults, so a
 *     config-less row does not reach apply() as `null`;
 *  2. DSH can render the fields instead of showing raw YAML.
 *
 * `@deepseek-ai/schemastery` is resolved at import time with a plain-object
 * fallback: a deployment that does not hoist the package still loads the
 * plugin (the loader accepts a plain schema object), it just loses validation
 * and defaults from the schema. The runtime defaults are ALSO applied inside
 * apply() so behaviour never depends on the schema being present.
 */
export const Config = buildConfigSchema();
function buildConfigSchema() {
    const plain = {
        type: 'object',
        properties: {
            host: { type: 'string', default: '127.0.0.1' },
            port: { type: 'number', default: 9222 },
            autoLaunchChrome: { type: 'boolean', default: true },
            extensionPort: { type: 'number', default: 18789 },
            transport: { type: 'string', enum: ['auto', 'extension', 'cdp'], default: 'auto' },
        },
    };
    // Try schemastery (gives validation + settings UI rendering).
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = createRequire(import.meta.url)('@deepseek-ai/schemastery');
        const z = mod?.default ?? mod;
        if (z && typeof z.object === 'function') {
            return z.object({
                host: z.string().default('127.0.0.1'),
                port: z.number().default(9222),
                autoLaunchChrome: z.boolean().default(true),
                extensionPort: z.number().default(18789),
                transport: z.union([z.const('auto'), z.const('extension'), z.const('cdp')]).default('auto'),
            });
        }
    }
    catch {
        // schemastery unavailable — fall through to the plain object.
    }
    return plain;
}
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 9222;
const DEFAULT_EXTENSION_PORT = 18789;
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
/** Lazily-created extension bridge (one per plugin mount). */
let extensionBridgeInstance = null;
export function apply(ctx, rawConfig) {
    // The cordis loader passes `null` for an entry mounted without an explicit
    // `config:` key — the default parameter only covers `undefined`, so a null
    // here used to throw "Cannot read properties of null (reading 'host')" and
    // the whole plugin failed to activate. Coalesce instead.
    const config = rawConfig ?? {};
    const host = typeof config.host === 'string' && config.host ? config.host : DEFAULT_HOST;
    const port = typeof config.port === 'number' ? config.port : DEFAULT_PORT;
    // extensionPort 0 disables the extension transport; undefined keeps default.
    const extensionPort = typeof config.extensionPort === 'number' ? config.extensionPort : DEFAULT_EXTENSION_PORT;
    const transport = config.transport === 'extension' || config.transport === 'cdp' ? config.transport : 'auto';
    context = createToolContext({
        host,
        port,
        autoLaunchChrome: config.autoLaunchChrome !== false,
        transport,
        getExtensionBridge: extensionPort === 0
            ? async () => null
            : async () => {
                try {
                    const mod = (await import('./extension/index.js'));
                    if (extensionBridgeInstance === null && mod?.ExtensionBridge) {
                        extensionBridgeInstance = new mod.ExtensionBridge({ port: extensionPort });
                    }
                    return extensionBridgeInstance ?? null;
                }
                catch {
                    // Extension transport unavailable (module missing / not built):
                    // degrade to CDP rather than failing the plugin.
                    return null;
                }
            },
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
        // Stop the extension bridge so the loopback port is released on unload.
        try {
            extensionBridgeInstance?.stop?.();
        }
        catch {
            // best-effort teardown
        }
        extensionBridgeInstance = null;
        context = undefined;
    }, 'ga-browser-bridge: tools');
}
//# sourceMappingURL=plugin.js.map