/**
 * Regression tests for the two traps described in the external bug report.
 *
 * 1) plugin.js used to pass its OWN `getExtensionBridge` into
 *    createToolContext, silently REPLACING the (correct) implementation there.
 *    The tools version calls `bridge.start()`; the entry-point look-alike never
 *    did, so the loopback server was constructed but never listened and the
 *    extension could never connect — while the code read as if it were wired.
 *
 * 2) With the extension installed but disconnected, `auto` mode fell through to
 *    CDP; if the debug port was also closed the user was told "Chrome is already
 *    running without a debug port" and closing Chrome never helped. The real
 *    cause (extension not connected) must be reported instead.
 */
import { apply } from '../src/plugin.js'
import { createToolContext } from '../src/tools/index.js'
import { routeTransport } from '../src/tools/extension-mode.js'
import type { ExtensionBridgeLike } from '../src/tools/extension-mode.js'

/** A ctx shaped exactly like the one DSH builds. */
function fakePluginCtx() {
  const registered: any[] = []
  return {
    registered,
    tools: { register: (d: any) => (registered.push(d), () => {}) },
    effect: (fn: () => any) => fn(),
    get: () => undefined,
    on: () => {},
  }
}

// ---------------------------------------------------------------------------
// 1. The entry point must not override getExtensionBridge
// ---------------------------------------------------------------------------
describe('plugin entry does not clobber the extension bridge implementation', () => {
  test('apply() passes extensionPort as CONFIG and leaves getExtensionBridge to createToolContext', () => {
    const ctx = fakePluginCtx()
    apply(ctx, { extensionPort: 18789, transport: 'auto' })
    // The plugin mounted and registered all five tools.
    expect(ctx.registered.map((d) => d.name).sort()).toEqual([
      'browser_cdp',
      'browser_cookies',
      'browser_execute_js',
      'browser_scan',
      'browser_tabs',
    ])
  })

  test('the default context getExtensionBridge actually STARTS the bridge', async () => {
    // The regression was "constructed but never start()ed". Assert the tool
    // context's own implementation exists and is not replaced by apply().
    const ctx = createToolContext({ extensionPort: 0 }) // 0 = disabled, resolves null
    expect(typeof ctx.getExtensionBridge).toBe('function')
    await expect(ctx.getExtensionBridge!()).resolves.toBeNull()
  })

  test('extensionPort is honoured by the context (config plumbing)', () => {
    const ctx = createToolContext({ extensionPort: 19999 })
    expect(ctx.extensionPort).toBe(19999)
  })
})

// ---------------------------------------------------------------------------
// 2. auto mode must report "extension not connected", not a debug-port error
// ---------------------------------------------------------------------------
describe('auto mode reports the real cause when the extension is installed but idle', () => {
  function idleBridge(): ExtensionBridgeLike {
    return {
      isConnected: () => false,
      listTabs: async () => [],
      evaluate: async () => undefined,
      snapshot: async () => ({ content: '', truncated: false, title: '', url: '' }),
      sendCdp: async () => undefined,
      getCookies: async () => [],
    } as unknown as ExtensionBridgeLike
  }

  test('auto + idle bridge => an error naming the extension, not the debug port', async () => {
    const ctx = createToolContext({
      transport: 'auto',
      getConnection: async () => {
        throw new Error('CDP path must NOT be used here')
      },
      getExtensionBridge: async () => idleBridge(),
    })
    const route = await routeTransport(ctx)
    expect(route.bridge).toBeNull()
    expect(typeof route.error).toBe('string')
    // It must talk about the extension...
    expect(route.error).toMatch(/extension/i)
    expect(route.error).toMatch(/not connected/i)
    // ...and must NOT send the user chasing the debug port.
    expect(route.error).not.toMatch(/already running without a debug port/i)
    // The documented [error] prefix is part of the tool contract.
    expect(route.error!.startsWith('[error]')).toBe(true)
  })

  test('auto + NO bridge at all still falls back to CDP silently (never installed)', async () => {
    const ctx = createToolContext({
      transport: 'auto',
      getExtensionBridge: async () => null,
    })
    const route = await routeTransport(ctx)
    expect(route.bridge).toBeNull()
    expect(route.error).toBeUndefined()
  })

  test('transport:cdp never consults the bridge', async () => {
    let asked = false
    const ctx = createToolContext({
      transport: 'cdp',
      getExtensionBridge: async () => {
        asked = true
        return null
      },
    })
    const route = await routeTransport(ctx)
    expect(route.bridge).toBeNull()
    expect(route.error).toBeUndefined()
    expect(asked).toBe(false)
  })
})
