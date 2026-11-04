/**
 * tests/dual-mode.routing.test.ts — dual-mode (extension ⇄ CDP) routing contract.
 *
 * Owned by the tools/extension-routing work. It pins the four things the
 * routing change must guarantee:
 *
 *  1. BACKWARD COMPATIBILITY — with no bridge available (the default), every
 *     tool takes the CDP path, unchanged. This is what keeps
 *     tests/tools.test.ts green.
 *  2. EXTENSION PRIORITY — in 'auto' mode a CONNECTED bridge wins.
 *  3. INERT WHEN DISCONNECTED — a bridge that exists but is not connected must
 *     fall back to CDP, not throw.
 *  4. FORCED MODES — 'cdp' never even asks the bridge; 'extension' prefers the
 *     bridge but still degrades to CDP when none is connected.
 *
 * The extension implementations are asserted against the SAME shapes the CDP
 * path produces, because the model-facing contract must not change.
 */
import { FakeCdpConnection, RecordedOp } from './setup';

import { TOOLS, createToolContext } from '@tools/index';
import type { ToolContext } from '@tools/index';
import type { ExtensionBridgeLike, ExtensionTabLike } from '@tools/extension-mode';

// ---------------------------------------------------------------------------
// Fake extension bridge (mirrors the shape in src/extension/bridge.ts)
// ---------------------------------------------------------------------------

class FakeExtensionBridge implements ExtensionBridgeLike {
  connected = true;
  tabs: ExtensionTabLike[] = [];
  /** recorded bridge calls, in order. */
  calls: Array<{ method: string; params?: any }> = [];
  /** per-method canned results. */
  results = new Map<string, any>();
  /** request() destination for protocol methods (tabs.activate/create/close). */
  requestResult: any = {};
  /** force evaluate() to look like a page throw. */
  evaluateThrows = false;

  isConnected(): boolean {
    return this.connected;
  }

  async listTabs(): Promise<ExtensionTabLike[]> {
    this.calls.push({ method: 'listTabs' });
    return this.tabs;
  }

  async evaluate(p: any): Promise<unknown> {
    this.calls.push({ method: 'evaluate', params: p });
    if (this.evaluateThrows) {
      const err: any = new Error(
        `The page threw while evaluating the expression: ReferenceError: foo is not defined`,
      );
      err.name = 'ExtensionBridgeError';
      err.code = 'PAGE_ERROR';
      err.detail = 'ReferenceError: foo is not defined';
      throw err;
    }
    return this.results.has('evaluate') ? this.results.get('evaluate') : 2;
  }

  async snapshot(p: any): Promise<any> {
    this.calls.push({ method: 'snapshot', params: p });
    return (
      this.results.get('snapshot') ?? {
        content: '<html>ext</html>',
        truncated: false,
        title: 'ext',
        url: 'https://example.com/',
      }
    );
  }

  async sendCdp(p: any): Promise<unknown> {
    this.calls.push({ method: 'sendCdp', params: p });
    const canned = this.results.get(`cdp:${p.method}`) ?? { ok: true };
    return typeof canned === 'function' ? canned(p.params) : canned;
  }

  async getCookies(p: any): Promise<unknown[]> {
    this.calls.push({ method: 'getCookies', params: p });
    return this.results.get('cookies') ?? [{ name: 'ext', domain: 'example.com' }];
  }

  /**
   * The request seam. The production code prefers this over the wrapper
   * methods (they are thin wrappers over it in the real bridge), so this is
   * where the fake must answer — delegate to the canned per-method results.
   */
  async request(req: any): Promise<unknown> {
    this.calls.push({ method: req.method, params: req.params });
    const p = req.params ?? {};
    switch (req.method) {
      case 'tabs.list':
        return this.tabs;
      case 'tabs.activate':
        return {};
      case 'tabs.close':
        return {};
      case 'tabs.create': {
        const id = 50 + this.tabs.length;
        this.tabs.push({
          id,
          title: '',
          url: p.url ?? 'about:blank',
          active: p.active === true,
          windowId: 1,
        });
        return { id };
      }
      case 'page.evaluate': {
        if (this.evaluateThrows) {
          return { value: null, exception: 'ReferenceError: foo is not defined' };
        }
        return { value: this.results.has('evaluate') ? this.results.get('evaluate') : 2 };
      }
      case 'page.snapshot':
        return (
          this.results.get('snapshot') ?? {
            content: '<html>ext</html>',
            truncated: false,
            title: 'ext',
            url: 'https://example.com/',
          }
        );
      case 'cdp.send': {
        const canned = this.results.get(`cdp:${p.method}`) ?? { ok: true };
        return typeof canned === 'function' ? canned(p.params) : canned;
      }
      case 'cookies.get':
        return { cookies: this.results.get('cookies') ?? [{ name: 'ext', domain: 'example.com' }] };
      default:
        return {};
    }
  }
}

function extTabs(): ExtensionTabLike[] {
  return [
    { id: 11, title: 'GitHub', url: 'https://github.com/some/repo', active: true, windowId: 1 },
    { id: 22, title: 'Example', url: 'https://example.com/page', active: false, windowId: 1 },
  ];
}

function cdpWithTwoTabs(): FakeCdpConnection {
  const conn = new FakeCdpConnection();
  conn.tabs = [
    { id: '1', type: 'page', title: 'GitHub', url: 'https://github.com/some/repo' },
    { id: '2', type: 'page', title: 'Example', url: 'https://example.com/page' },
  ];
  return conn;
}

/** Context whose bridge resolves to `bridge` (or null). */
function ctxWith(
  conn: FakeCdpConnection,
  bridge: ExtensionBridgeLike | null,
  transport?: ToolContext['transport'],
): ToolContext {
  return createToolContext({
    host: '127.0.0.1',
    port: 9222,
    getConnection: async () => conn as any,
    getOrCreateBrowser: async () => {},
    defaultTimeoutMs: 30000,
    getExtensionBridge: async () => bridge as any,
    transport,
  });
}

async function call(name: string, args: any, ctx: ToolContext): Promise<string> {
  return TOOLS[name].fn(args, ctx);
}

// ---------------------------------------------------------------------------
// 1. Backward compatibility: no bridge -> CDP path, untouched
// ---------------------------------------------------------------------------

describe('dual-mode routing: no bridge (backward compatibility)', () => {
  test('auto mode with a null bridge uses CDP for tabs list', async () => {
    const conn = cdpWithTwoTabs();
    const ctx = ctxWith(conn, null);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
    // CDP mode ids are the target ids, NOT chrome.tabs ids.
    expect(parsed.tabs[0].id).toBe('1');
  });

  test('auto mode with no getExtensionBridge at all still uses CDP', async () => {
    const conn = cdpWithTwoTabs();
    const ctx = createToolContext({
      getConnection: async () => conn as any,
      defaultTimeoutMs: 30000,
    });
    // The default bridge factory must degrade to null, never throw.
    await expect(ctx.getExtensionBridge?.()).resolves.toBeNull();
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(JSON.parse(out).count).toBe(2);
  });

  test('auto mode with a DISCONNECTED bridge reports the extension, NOT a fallback', async () => {
    // CONTRACT CHANGE (external bug report, issue 2). A bridge that exists but
    // has no connected extension means the user DID install the extension and
    // it is not talking to us. Silently falling back to CDP made the user read
    // "Chrome is already running without a debug port", and closing Chrome —
    // exactly what that message instructs — never helped. Report the real
    // cause, and do not touch either transport.
    const conn = cdpWithTwoTabs();
    const bridge = new FakeExtensionBridge();
    bridge.connected = false;
    bridge.tabs = extTabs();
    const ctx = ctxWith(conn, bridge);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
    expect(out).toMatch(/extension/i);
    expect(out).toMatch(/not connected/i);
    expect(out).not.toMatch(/already running without a debug port/i);
    expect(bridge.calls.filter((c) => c.method === 'tabs.list')).toHaveLength(0);
    expect(conn.ops).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Extension priority in auto mode
// ---------------------------------------------------------------------------

describe('dual-mode routing: extension priority in auto mode', () => {
  test('a connected bridge wins for tabs list, with String() ids', async () => {
    const conn = cdpWithTwoTabs();
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(conn, bridge);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
    // Tool contract keeps STRING ids even though chrome.tabs uses numbers.
    expect(parsed.tabs).toEqual([
      { id: '11', title: 'GitHub', url: 'https://github.com/some/repo' },
      { id: '22', title: 'Example', url: 'https://example.com/page' },
    ]);
    // CDP must not have been touched.
    expect(conn.ops).toHaveLength(0);
  });

  test('find matches on url substring like the CDP path', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_tabs', { action: 'find', url_pattern: 'github' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(1);
    expect(parsed.tabs[0].id).toBe('11');
  });

  test('switch activates via the extension and remembers the tab', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_tabs', { action: 'switch', tab_id: '22' }, ctx);
    expect(out).toBe('true');
    expect(ctx.currentTabId).toBe('22');
    expect(bridge.calls.some((c) => c.method === 'tabs.activate')).toBe(true);
  });

  test('switch to an UNKNOWN id is a clean error, not a crash', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    // '1' is a valid CDP target id but means nothing to the extension.
    const out = await call('browser_tabs', { action: 'switch', tab_id: '1' }, ctx);
    expect(out).toBe('[error] tab not found: 1');
  });

  test('create returns the created tab row', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_tabs', { action: 'create', url: 'https://new.page/' }, ctx);
    const parsed = JSON.parse(out);
    expect(String(parsed.id)).toBeTruthy();
    expect(parsed.url).toBe('https://new.page/');
  });

  test('scan honours text_only and maxchars through bridge.snapshot', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('snapshot', {
      content: 'x'.repeat(500),
      truncated: false,
      title: 't',
      url: 'u',
    });
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_scan', { tab_id: '11', text_only: true, maxchars: 100 }, ctx);
    expect(out).toBe('x'.repeat(100));
    const snap = bridge.calls.find((c) => c.method === 'page.snapshot')!;
    expect(snap.params.textOnly).toBe(true);
    expect(snap.params.maxchars).toBe(100);
  });

  test('scan on an empty page returns "(empty page)"', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('snapshot', { content: '', truncated: false, title: 't', url: 'u' });
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    expect(await call('browser_scan', { tab_id: '11' }, ctx)).toBe('(empty page)');
  });

  test('execute_js wraps a value as {result: value}', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('evaluate', 2);
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_execute_js', { tab_id: '11', script: '1+1' }, ctx);
    expect(out).toBe(JSON.stringify({ result: 2 }));
    const ev = bridge.calls.find((c) => c.method === 'page.evaluate')!;
    expect(ev.params.awaitPromise).toBe(true);
    expect(ev.params.returnByValue).toBe(true);
  });

  test('execute_js renders a page exception as "[error] <json text>"', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.evaluateThrows = true;
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_execute_js', { tab_id: '11', script: 'foo()' }, ctx);
    expect(out).toBe('[error] "ReferenceError: foo is not defined"');
  });

  test('execute_js still rejects an empty script before any transport work', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    expect(await call('browser_execute_js', { script: '  ' }, ctx)).toBe('[error] empty script');
    expect(bridge.calls).toHaveLength(0);
  });

  test('single cdp sends through bridge.sendCdp for the resolved tab', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('cdp:Page.captureScreenshot', { data: 'PNG' });
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call(
      'browser_cdp',
      { tab_id: '11', method: 'Page.captureScreenshot', params: { format: 'png' } },
      ctx,
    );
    expect(JSON.parse(out)).toEqual({ data: 'PNG' });
    const sent = bridge.calls.find((c) => c.method === 'cdp.send')!;
    expect(sent.params.tabId).toBe(11);
    expect(sent.params.method).toBe('Page.captureScreenshot');
  });

  test('cdp batch resolves $N.path refs exactly like the CDP path', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('cdp:Page.captureScreenshot', { data: 'PNGDATA' });
    bridge.results.set('cdp:Input.insertText', (params: any) => ({ inserted: params.text }));
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call(
      'browser_cdp',
      {
        tab_id: '11',
        commands: [
          { cmd: 'cdp', method: 'Page.captureScreenshot', params: {} },
          { cmd: 'cdp', method: 'Input.insertText', params: { text: '$0.data' } },
        ],
      },
      ctx,
    );
    const parsed = JSON.parse(out);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toEqual({ inserted: 'PNGDATA' });
  });

  test('cookies come from bridge.getCookies for the tab url', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    bridge.results.set('cookies', [{ name: 'sid', domain: 'example.com' }]);
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_cookies', { tab_id: '22' }, ctx);
    expect(JSON.parse(out).cookies).toEqual([{ name: 'sid', domain: 'example.com' }]);
    const got = bridge.calls.find((c) => c.method === 'cookies.get')!;
    expect(got.params.url).toBe('https://example.com/page');
  });

  test('a tab_id from the OTHER mode is a clean "tab not found", never a crash', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_tabs', { action: 'close', tab_id: '1' }, ctx);
    expect(out).toBe('[error] tab not found: 1');
  });
});

// ---------------------------------------------------------------------------
// 3. Forced modes
// ---------------------------------------------------------------------------

describe('dual-mode routing: forced transports', () => {
  // 'extension' PREFERS the bridge. When none is available it must degrade to
  // CDP rather than error: a user without the MV3 extension installed still
  // has to get a working plugin (same rule as tests/extension.test.ts #13).
  test("transport 'extension' reports an error when no bridge exists", async () => {
    // CONTRACT CHANGE (external report): forced extension mode must FAIL LOUDLY.
    // Silently using the debug port told the user "Chrome is already running
    // without a debug port" and sent them chasing the wrong thing.
    const ctx = ctxWith(cdpWithTwoTabs(), null, 'extension');
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
    expect(out).toMatch(/extension/i);
  });

  test("transport 'extension' reports an error when the bridge is disconnected", async () => {
    const bridge = new FakeExtensionBridge();
    bridge.connected = false;
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge, 'extension');
    const out = await call('browser_scan', {}, ctx);
    expect(out.startsWith('[error]')).toBe(true);
    expect(out).toMatch(/extension/i);
    expect(out).not.toMatch(/already running without a debug port/i);
  });

  test("transport 'extension' with a connected bridge uses it", async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    const ctx = ctxWith(cdpWithTwoTabs(), bridge, 'extension');
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(JSON.parse(out).tabs[0].id).toBe('11');
  });

  test("transport 'cdp' never asks for the bridge", async () => {
    const conn = cdpWithTwoTabs();
    const bridge = new FakeExtensionBridge();
    bridge.tabs = extTabs();
    let asked = false;
    const ctx = createToolContext({
      getConnection: async () => conn as any,
      defaultTimeoutMs: 30000,
      getExtensionBridge: async () => {
        asked = true;
        return bridge as any;
      },
      transport: 'cdp',
    });
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(JSON.parse(out).tabs[0].id).toBe('1');
    expect(asked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Contract stability
// ---------------------------------------------------------------------------

describe('dual-mode routing: public contract unchanged', () => {
  test.each(['browser_tabs', 'browser_scan', 'browser_execute_js', 'browser_cdp', 'browser_cookies'])(
    '%s keeps a description and object schema',
    (name) => {
      expect(typeof TOOLS[name].description).toBe('string');
      expect((TOOLS[name].inputSchema as any).type).toBe('object');
    },
  );

  test('a connected bridge with zero tabs reports an empty list, not the port-9222 error', async () => {
    const bridge = new FakeExtensionBridge();
    bridge.tabs = [];
    const ctx = ctxWith(cdpWithTwoTabs(), bridge);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(JSON.parse(out)).toEqual({ count: 0, tabs: [] });
  });
});

// Keep RecordedOp referenced so the import documents intent for future edits.
void ({} as RecordedOp);
