/**
 * tests/tools.test.ts — core tool tests against the src/tools/index.ts contract.
 *
 * Behavioral spec: the old Python bridge br_mcp.py (read-only). Tests use a
 * fake CdpConnection (FakeCdpConnection/FakeTargetSession from ./setup) —
 * NO real Chrome, NO network, NO module mocks.
 *
 * Routing (lead-arbitrated, plan A): tabs create/switch/close go through
 * CdpConnection methods (conn.createTarget/activateTarget/closeTarget);
 * scan/execute/cdp/cookies go through conn.attach() + session.send().
 * Response envelopes: the fake returns RAW CDP wire envelopes
 * ({result:{...}}); the tools' unwrap() helpers accept both raw and
 * unwrapped shapes, so assertions below work either way.
 *
 * RED: implementation incomplete — imports fail. Expected.
 */
import {
  FakeCdpConnection,
  FakeTargetSession,
  NO_BROWSER_ERROR_PREFIX,
  RecordedCall,
  RecordedOp,
  FakeCdpTarget,
} from './setup';

import { TOOLS, createToolContext } from '@tools/index';
import type { ToolContext } from '@tools/index';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(conn: FakeCdpConnection): ToolContext {
  return createToolContext({
    host: '127.0.0.1',
    port: 9222,
    getConnection: async () => conn as any,
    getOrCreateBrowser: async () => {},
    defaultTimeoutMs: 30000,
  });
}

function twoTabs(): FakeCdpConnection {
  const conn = new FakeCdpConnection();
  conn.tabs = [
    {
      id: '1',
      type: 'page',
      title: 'GitHub',
      url: 'https://github.com/some/repo',
      webSocketDebuggerUrl: 'ws://1',
    },
    {
      id: '2',
      type: 'page',
      title: 'Example',
      url: 'https://example.com/page',
      webSocketDebuggerUrl: 'ws://2',
    },
  ];
  return conn;
}

async function call(name: string, args: any, ctx: ToolContext): Promise<string> {
  const spec = TOOLS[name];
  if (!spec) throw new Error(`tool ${name} missing from TOOLS`);
  return spec.fn(args, ctx);
}

/**
 * Runtime.evaluate canned responder. Accepts the raw wire envelope shape
 * ({result:{result:{value}}}) which the tools' unwrap() helpers tolerate.
 */
function evalResponder(value: any) {
  return () => ({ result: { result: { value } } });
}

// ---------------------------------------------------------------------------
// 12. TOOLS registry shape
// ---------------------------------------------------------------------------

describe('TOOLS registry', () => {
  const expected = [
    'browser_tabs',
    'browser_scan',
    'browser_execute_js',
    'browser_cdp',
    'browser_cookies',
  ];

  test('all five tool names exist in TOOLS', () => {
    for (const n of expected) {
      expect(TOOLS[n]).toBeDefined();
      expect(typeof TOOLS[n].fn).toBe('function');
    }
  });

  test.each(expected)('%s has non-empty description and object inputSchema', (n) => {
    const spec = TOOLS[n];
    expect(typeof spec.description).toBe('string');
    expect(spec.description.length).toBeGreaterThan(0);
    expect(spec.inputSchema).toBeDefined();
    expect((spec.inputSchema as any).type).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// browser_tabs
// ---------------------------------------------------------------------------

describe('browser_tabs', () => {
  test('1. list: two fake tabs -> JSON with count:2 and tabs array of {id,title,url}', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
    expect(Array.isArray(parsed.tabs)).toBe(true);
    expect(parsed.tabs).toHaveLength(2);
    for (const t of parsed.tabs) {
      expect(Object.keys(t)).toEqual(expect.arrayContaining(['id', 'title', 'url']));
    }
    expect(parsed.tabs[0]).toMatchObject({
      id: '1',
      title: 'GitHub',
      url: 'https://github.com/some/repo',
    });
    expect(parsed.tabs[1]).toMatchObject({
      id: '2',
      title: 'Example',
      url: 'https://example.com/page',
    });
  });

  test('2. list with zero tabs -> no-browser error string', async () => {
    const conn = new FakeCdpConnection(); // no tabs
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'list' }, ctx);
    expect(out).toContain(NO_BROWSER_ERROR_PREFIX);
  });

  test('3. find: url_pattern "github" matches 1 of 2 tabs -> matched:1', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'find', url_pattern: 'github' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(1);
    expect(parsed.tabs).toHaveLength(1);
    expect(parsed.tabs[0].url).toContain('github.com');
  });

  test('3b. find supports legacy "pattern" alias too', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'find', pattern: 'example' }, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.matched).toBe(1);
    expect(parsed.tabs[0].id).toBe('2');
  });

  test('3c. find: empty pattern -> matched is a number, tabs is an array (shape only)', async () => {
    // br_mcp.py: `pat in url` with pat="" matches every tab. The TS impl
    // guards `pat !== ''` (0 matches). The edge is impl-defined; we pin only
    // the shape (assumption documented for the lead).
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'find', url_pattern: '' }, ctx);
    const parsed = JSON.parse(out);
    expect(typeof parsed.matched).toBe('number');
    expect(Array.isArray(parsed.tabs)).toBe(true);
  });

  test('4. switch: missing tab_id -> "[error] switch needs tab_id"', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'switch' }, ctx);
    expect(out).toBe('[error] switch needs tab_id');
  });

  test('4b. switch: with tab_id -> conn.activateTarget op recorded, ctx.currentTabId set', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'switch', tab_id: '2' }, ctx);
    // Plan-A routing: activation is a connection-level op.
    const opHit = conn.ops.some(
      (o: RecordedOp) => o.op === 'activateTarget' && o.targetId === '2',
    );
    // Tolerate a session-routed impl as well (brief's contract variant).
    const sessionHit = conn.sessions
      .get('2')
      ?.sent.some((c: RecordedCall) => c.method === 'Target.activateTarget');
    expect(opHit || sessionHit).toBe(true);
    // br_mcp.py _select() remembers the chosen tab; ctx.currentTabId is the
    // TS contract's equivalent.
    expect(ctx.currentTabId).toBe('2');
    expect(typeof out).toBe('string');
    expect(out).not.toBe('[error] switch needs tab_id');
  });

  test('4c. switch: unknown tab_id -> "[error]" (not a crash)', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'switch', tab_id: '999' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
  });

  test('5. create: url param -> conn.createTarget called with url, result JSON contains the url', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'create', url: 'https://new.page/' }, ctx);
    const opHit = conn.ops.some(
      (o: RecordedOp) => o.op === 'createTarget' && o.params?.url === 'https://new.page/',
    );
    expect(opHit).toBe(true);
    // Impl re-lists to build the full row; the fake's createTarget adds the
    // tab, so the url must appear in the JSON output.
    expect(out).toContain('https://new.page/');
    expect(typeof out).toBe('string');
  });

  test('5b. create defaults url to about:blank when omitted', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'create' }, ctx);
    const opHit = conn.ops.some(
      (o: RecordedOp) => o.op === 'createTarget' && (o.params?.url ?? 'about:blank') === 'about:blank',
    );
    expect(opHit).toBe(true);
    expect(typeof out).toBe('string');
  });

  test('5c. create with active:true -> createTarget then activateTarget, currentTabId set', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    await call('browser_tabs', { action: 'create', url: 'https://active.page/', active: true }, ctx);
    const created = conn.ops.find((o: RecordedOp) => o.op === 'createTarget');
    expect(created).toBeDefined();
    // The created tab lands in the fake's listing (fake createTarget pushes
    // it); activation must target THAT tab's id.
    const createdTab = conn.tabs.find((t: FakeCdpTarget) => t.url === 'https://active.page/');
    expect(createdTab).toBeDefined();
    const activated = conn.ops.find(
      (o: RecordedOp) => o.op === 'activateTarget' && o.targetId === createdTab!.id,
    );
    expect(activated).toBeDefined();
    expect(ctx.currentTabId).toBe(createdTab!.id);
  });

  test('6. close: missing tab_id -> "[error] close needs tab_id"', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'close' }, ctx);
    expect(out).toBe('[error] close needs tab_id');
  });

  test('6b. close: with id -> conn.closeTarget op recorded for that id', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'close', tab_id: '1' }, ctx);
    const opHit = conn.ops.some(
      (o: RecordedOp) => o.op === 'closeTarget' && o.targetId === '1',
    );
    // Tolerate a session-close impl variant too.
    const sessionHit = conn.sessions.get('1')?.closed === true;
    expect(opHit || sessionHit).toBe(true);
    expect(typeof out).toBe('string');
  });

  test('6c. close: unknown tab_id -> "[error]" (not a crash)', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'close', tab_id: '999' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
  });

  test('7. unknown action -> "[error] unknown action: xyz (list/find/switch/create/close)"', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', { action: 'xyz' }, ctx);
    expect(out).toBe('[error] unknown action: xyz (list/find/switch/create/close)');
  });

  test('7b. default action is list when action omitted', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_tabs', {}, ctx);
    const parsed = JSON.parse(out);
    expect(parsed.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// browser_scan
// ---------------------------------------------------------------------------

describe('browser_scan', () => {
  const html = '<html><body><h1>Title</h1><p>Body text here</p></body></html>';

  function attachScanSession(conn: FakeCdpConnection, value: string): FakeTargetSession {
    const session = new FakeTargetSession('1');
    session.on('Runtime.evaluate', evalResponder(value));
    conn.sessions.set('1', session);
    return session;
  }

  test('8. returns the evaluated value text', async () => {
    const conn = twoTabs();
    attachScanSession(conn, html);
    const ctx = makeCtx(conn);
    const out = await call('browser_scan', { tab_id: '1' }, ctx);
    expect(out).toBe(html);
  });

  test('8b. text_only:true path returns text only and asks the page for text', async () => {
    const conn = twoTabs();
    const session = new FakeTargetSession('1');
    session.on('Runtime.evaluate', evalResponder('visible text only'));
    conn.sessions.set('1', session);
    const ctx = makeCtx(conn);
    const out = await call('browser_scan', { tab_id: '1', text_only: true }, ctx);
    expect(out).toBe('visible text only');
    // The impl must have asked the page for visible text (innerText).
    const evalCall = session.sent.find((c: RecordedCall) => c.method === 'Runtime.evaluate');
    expect(evalCall).toBeDefined();
    const expressions = JSON.stringify(session.sent.map((c: RecordedCall) => c.params?.expression));
    expect(expressions).toMatch(/innerText|textContent/i);
  });

  test('8c. maxchars truncates long values', async () => {
    const conn = twoTabs();
    attachScanSession(conn, 'x'.repeat(500));
    const ctx = makeCtx(conn);
    const out = await call('browser_scan', { tab_id: '1', maxchars: 100 }, ctx);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  test('8d. empty value -> "(empty page)"', async () => {
    const conn = twoTabs();
    attachScanSession(conn, '');
    const ctx = makeCtx(conn);
    const out = await call('browser_scan', { tab_id: '1' }, ctx);
    expect(out).toBe('(empty page)');
  });

  test('8e. zero tabs -> no-browser error', async () => {
    const conn = new FakeCdpConnection();
    const ctx = makeCtx(conn);
    const out = await call('browser_scan', {}, ctx);
    expect(out).toContain(NO_BROWSER_ERROR_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// browser_execute_js
// ---------------------------------------------------------------------------

describe('browser_execute_js', () => {
  function attachExecSession(conn: FakeCdpConnection, responder: any): FakeTargetSession {
    const session = new FakeTargetSession('1');
    session.on('Runtime.evaluate', responder);
    conn.sessions.set('1', session);
    return session;
  }

  test('9. missing/blank script -> "[error] empty script"', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    expect(await call('browser_execute_js', {}, ctx)).toBe('[error] empty script');
    expect(await call('browser_execute_js', { script: '   ' }, ctx)).toBe('[error] empty script');
  });

  test('9b. script "1+1" -> output contains "2", expression forwarded verbatim', async () => {
    const conn = twoTabs();
    attachExecSession(conn, evalResponder(2));
    const ctx = makeCtx(conn);
    const out = await call('browser_execute_js', { tab_id: '1', script: '1+1' }, ctx);
    expect(out).toContain('2');
    const session = conn.sessions.get('1')!;
    const evalCall = session.sent.find((c: RecordedCall) => c.method === 'Runtime.evaluate');
    expect(evalCall).toBeDefined();
    expect(evalCall!.params?.expression).toContain('1+1');
  });

  test('9c. exceptionDetails path -> output starts with "[error]"', async () => {
    const conn = twoTabs();
    attachExecSession(conn, () => ({
      result: { exceptionDetails: { text: 'ReferenceError: foo is not defined' } },
    }));
    const ctx = makeCtx(conn);
    const out = await call('browser_execute_js', { tab_id: '1', script: 'foo()' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
  });

  test('9d. send() rejection surfaces as "[error] ..." too', async () => {
    const conn = twoTabs();
    const session = new FakeTargetSession('1');
    session.throwOnMethod = 'Runtime.evaluate';
    session.errorToThrow = new Error('boom');
    conn.sessions.set('1', session);
    const ctx = makeCtx(conn);
    const out = await call('browser_execute_js', { tab_id: '1', script: '1' }, ctx);
    expect(out.startsWith('[error]')).toBe(true);
  });

  test('9e. zero tabs -> no-browser error', async () => {
    const conn = new FakeCdpConnection();
    const ctx = makeCtx(conn);
    const out = await call('browser_execute_js', { script: '1' }, ctx);
    expect(out).toContain(NO_BROWSER_ERROR_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// browser_cdp
// ---------------------------------------------------------------------------

describe('browser_cdp', () => {
  test('10. method + params forwarded to session.send exactly', async () => {
    const conn = twoTabs();
    const session = new FakeTargetSession('1');
    session.on('Page.captureScreenshot', { result: { data: 'BASE64==' } });
    conn.sessions.set('1', session);
    const ctx = makeCtx(conn);
    const out = await call(
      'browser_cdp',
      { tab_id: '1', method: 'Page.captureScreenshot', params: { format: 'png' } },
      ctx,
    );
    const callRec = session.sent.find(
      (c: RecordedCall) => c.method === 'Page.captureScreenshot',
    );
    expect(callRec).toBeDefined();
    expect(callRec!.params).toEqual({ format: 'png' });
    expect(out).toContain('BASE64');
  });

  test('10b. commands batch of 2 -> both executed, results array length 2', async () => {
    const conn = twoTabs();
    const session = new FakeTargetSession('1');
    session.on('Page.getNavigationHistory', { currentIndex: 0, entries: [] });
    session.on('DOM.getDocument', { root: { nodeId: 1 } });
    conn.sessions.set('1', session);
    const ctx = makeCtx(conn);
    const commands = [
      { cmd: 'cdp', method: 'Page.getNavigationHistory', params: {} },
      { cmd: 'cdp', method: 'DOM.getDocument', params: {} },
    ];
    const out = await call('browser_cdp', { tab_id: '1', commands }, ctx);
    expect(
      session.sent.filter((c: RecordedCall) => c.method === 'Page.getNavigationHistory'),
    ).toHaveLength(1);
    expect(session.sent.filter((c: RecordedCall) => c.method === 'DOM.getDocument')).toHaveLength(1);
    const parsed = JSON.parse(out);
    const results: any[] = Array.isArray(parsed) ? parsed : parsed.results ?? parsed.data ?? parsed;
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(2);
  });

  test('10c. $0.ref resolution: "$0.data" in second command resolves to first result', async () => {
    const conn = twoTabs();
    const session = new FakeTargetSession('1');
    // Raw wire envelope; resolveRef() tries base and base.result.
    session.on('Page.captureScreenshot', { result: { data: 'SCREENSHOT_BASE64' } });
    session.on('Input.insertText', { ok: true });
    conn.sessions.set('1', session);
    const ctx = makeCtx(conn);
    const commands = [
      { cmd: 'cdp', method: 'Page.captureScreenshot', params: { format: 'png' } },
      { cmd: 'cdp', method: 'Input.insertText', params: { text: '$0.data' } },
    ];
    const out = await call('browser_cdp', { tab_id: '1', commands }, ctx);
    const insertCall = session.sent.find(
      (c: RecordedCall) => c.method === 'Input.insertText',
    );
    expect(insertCall).toBeDefined();
    // The literal "$0.data" must NOT be forwarded; the resolved value must be.
    expect(JSON.stringify(insertCall!.params)).not.toContain('$0.data');
    expect(JSON.stringify(insertCall!.params)).toContain('SCREENSHOT_BASE64');
    expect(out.length).toBeGreaterThan(0);
  });

  test('10d. neither method nor commands -> "[error] need method or commands"', async () => {
    const conn = twoTabs();
    const ctx = makeCtx(conn);
    const out = await call('browser_cdp', { tab_id: '1' }, ctx);
    expect(out).toBe('[error] need method or commands');
  });

  test('10e. zero tabs -> no-browser error', async () => {
    const conn = new FakeCdpConnection();
    const ctx = makeCtx(conn);
    const out = await call('browser_cdp', { method: 'Page.captureScreenshot' }, ctx);
    expect(out).toContain(NO_BROWSER_ERROR_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// browser_cookies
// ---------------------------------------------------------------------------

describe('browser_cookies', () => {
  test('11. Storage.getCookies -> origin-filtered; HttpOnly included; others excluded', async () => {
    const conn = new FakeCdpConnection();
    conn.tabs = [
      {
        id: '1',
        type: 'page',
        title: 'Example',
        url: 'https://example.com/x',
        webSocketDebuggerUrl: 'ws://1',
      },
    ];
    const cookies = [
      { name: 'sessionid', value: 'abc', domain: '.example.com', httpOnly: true },
      { name: 'tracker', value: 'xyz', domain: '.other-site.net', httpOnly: false },
      { name: 'theme', value: 'dark', domain: '.example.com', httpOnly: false },
    ];
    // Chrome 155 REMOVED Network.getAllCookies; the implementation asks
    // Storage.getCookies first (browser-level, sent on the CONNECTION).
    conn.on('Storage.getCookies', { result: { cookies } });
    const ctx = makeCtx(conn);
    const out = await call('browser_cookies', { tab_id: '1' }, ctx);
    const parsed = JSON.parse(out);
    const text = JSON.stringify(parsed);
    // HttpOnly cookie for the tab origin must be present.
    expect(text).toContain('sessionid');
    expect(text).toContain('abc');
    expect(text).toContain('true'); // httpOnly flag survives
    // Cookie from a foreign origin must be excluded.
    expect(text).not.toContain('tracker');
    // Same-origin non-HttpOnly cookie may be present.
    expect(text).toContain('theme');
    // The modern API must be the one actually used.
    expect(
      conn.sent.some((c: RecordedCall) => c.method === 'Storage.getCookies'),
    ).toBe(true);
  });

  test('11c. falls back to Network.getAllCookies on older Chrome', async () => {
    const conn = new FakeCdpConnection();
    conn.tabs = [
      { id: '1', type: 'page', title: 'Example', url: 'https://example.com/x' },
    ];
    const cookies = [
      { name: 'legacy', value: 'v', domain: '.example.com', httpOnly: false },
    ];
    // Simulate a pre-155 Chrome where Storage.getCookies does not exist.
    conn.throwOnMethod = 'Storage.getCookies';
    conn.errorToThrow = new Error("'Storage.getCookies' wasn't found");
    conn.on('Network.getAllCookies', { result: { cookies } });
    const ctx = makeCtx(conn);
    const out = await call('browser_cookies', { tab_id: '1' }, ctx);
    expect(JSON.parse(out).cookies.some((c: any) => c.name === 'legacy')).toBe(true);
    expect(
      conn.sent.some((c: RecordedCall) => c.method === 'Network.getAllCookies'),
    ).toBe(true);
  });

  test('11b. zero tabs -> no-browser error', async () => {
    const conn = new FakeCdpConnection();
    const ctx = makeCtx(conn);
    const out = await call('browser_cookies', {}, ctx);
    expect(out).toContain(NO_BROWSER_ERROR_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// createToolContext defaults
// ---------------------------------------------------------------------------

describe('createToolContext', () => {
  test('returns a context with sane defaults and honors overrides', async () => {
    const conn = twoTabs();
    const ctx = createToolContext({
      getConnection: async () => conn as any,
      defaultTimeoutMs: 1234,
    });
    expect(ctx.defaultTimeoutMs).toBe(1234);
    expect(typeof ctx.getConnection).toBe('function');
    expect(typeof ctx.getOrCreateBrowser).toBe('function');
    const c = await ctx.getConnection();
    expect(c).toBe(conn);
  });
});
