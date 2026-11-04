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

import { TOOLS, createToolContext, type ToolSpec } from './tools/index.js'

export const name = 'ga-browser-bridge'
export const inject = ['tools']

export interface PluginConfig {
  /** CDP debug host. Default '127.0.0.1'. */
  host?: string
  /** CDP debug port. Default 9222. */
  port?: number
  /**
   * When the debug port is closed, automatically launch Chrome with
   * --remote-debugging-port (reusing the user's default profile so login
   * state is preserved). Default true. When false, tools fail fast with a
   * message telling the user the exact launch command.
   *
   * NOTE: on Chrome 136+ the default profile CANNOT open a debug port, so
   * this only works with a separate DSH_BROWSER_USER_DATA_DIR. The extension
   * transport (extensionPort) does not have this limitation.
   */
  autoLaunchChrome?: boolean
  /**
   * Loopback port the plugin listens on so the DSH Browser Bridge Chrome
   * extension can connect. Default 18765. Set to 0 to disable the
   * extension transport entirely (CDP-only mode).
   */
  extensionPort?: number
  /**
   * Transport preference:
   *  - 'auto' (default): use the extension when it is connected, else CDP.
   *  - 'extension': require the extension; fail clearly if it is missing.
   *  - 'cdp': always use the debug port (ignore any connected extension).
   */
  transport?: 'auto' | 'extension' | 'cdp'
}

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 9222
const DEFAULT_EXTENSION_PORT = 18765

/** Render a tool result for DSH: plain text content block. */
const stringOutput = {
  schema: { type: 'string' },
  render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
}

/** Map our ToolSpec (br_mcp.py-shaped) onto ctx.tools.register's shape. */
function toRegisteredTool(spec: ToolSpec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.inputSchema,
    output: stringOutput,
    async execute(args: Record<string, unknown>, _exec: unknown) {
      const toolCtx = context
      if (!toolCtx) {
        return '[error] plugin context not initialized (missing ToolContext)'
      }
      try {
        return await spec.fn(args, toolCtx)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return `[error] ${error instanceof Error ? error.constructor.name : 'Error'}: ${message}`
      }
    },
  }
}

/** Single tool context per plugin mount (module-scoped, set by apply). */
let context: ReturnType<typeof createToolContext> | undefined
/** Lazily-created extension bridge (one per plugin mount). */
let extensionBridgeInstance: any = null

export function apply(ctx: any, rawConfig?: PluginConfig | null) {
  // The cordis loader passes `null` for an entry mounted without an explicit
  // `config:` key — the default parameter only covers `undefined`, so a null
  // here used to throw "Cannot read properties of null (reading 'host')" and
  // the whole plugin failed to activate. Coalesce instead.
  const config = rawConfig ?? {}
  const host = typeof config.host === 'string' && config.host ? config.host : DEFAULT_HOST
  const port = typeof config.port === 'number' ? config.port : DEFAULT_PORT
  // extensionPort 0 disables the extension transport; undefined keeps default.
  const extensionPort =
    typeof config.extensionPort === 'number' ? config.extensionPort : DEFAULT_EXTENSION_PORT
  const transport =
    config.transport === 'extension' || config.transport === 'cdp' ? config.transport : 'auto'

  context = createToolContext({
    host,
    port,
    autoLaunchChrome: config.autoLaunchChrome !== false,
    transport,
    getExtensionBridge:
      extensionPort === 0
        ? async () => null
        : async () => {
            try {
              const mod = (await import('./extension/index.js')) as any
              if (extensionBridgeInstance === null && mod?.ExtensionBridge) {
                extensionBridgeInstance = new mod.ExtensionBridge({ port: extensionPort })
              }
              return extensionBridgeInstance ?? null
            } catch {
              // Extension transport unavailable (module missing / not built):
              // degrade to CDP rather than failing the plugin.
              return null
            }
          },
  })

  const disposers: Array<() => void> = []
  for (const spec of Object.values(TOOLS)) {
    disposers.push(ctx.tools.register(toRegisteredTool(spec)))
  }

  ctx.effect(
    () => () => {
      disposers.splice(0).forEach((dispose) => {
        try {
          dispose()
        } catch {
          // best-effort teardown
        }
      })
      // Stop the extension bridge so the loopback port is released on unload.
      try {
        extensionBridgeInstance?.stop?.()
      } catch {
        // best-effort teardown
      }
      extensionBridgeInstance = null
      context = undefined
    },
    'ga-browser-bridge: tools',
  )
}
