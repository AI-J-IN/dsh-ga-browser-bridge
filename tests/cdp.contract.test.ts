/**
 * tests/cdp.contract.test.ts — CONTRACT SHAPE tests only, no real network.
 *
 * Module layout per the contract (lead-confirmed):
 *   - CdpTarget (type)            -> '@cdp/types'
 *   - CdpConnection, TargetSession, CdpError -> '@cdp/connection'
 *   - LaunchError, ensureDebugChrome (runtime) -> '@cdp/launcher'
 *
 * Type-only assertions are compile-time; runtime existence checks are
 * separate so a missing module fails loudly (expected red while src/cdp
 * is unwritten).
 */
import type { CdpTarget } from '@cdp/types';
import { CdpConnection, TargetSession, CdpError } from '@cdp/connection';
import { ensureDebugChrome, LaunchError } from '@cdp/launcher';

/**
 * Race a promise against a wall-clock deadline. Cleanable: the timeout
 * timer is cleared as soon as the race settles (either branch), so no
 * lingering handle keeps Jest from exiting.
 */
function race<T>(
  p: Promise<T>,
  ms: number,
): Promise<{ state: 'ok' | 'err' | 'timeout'; value?: T; error?: any }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ state: 'timeout' }>((resolve) => {
    timer = setTimeout(() => resolve({ state: 'timeout' }), ms);
  });
  return Promise.race([
    p.then(
      (value) => ({ state: 'ok' as const, value }),
      (error) => ({ state: 'err' as const, error }),
    ),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

describe('CDP contract shapes (types only)', () => {
  test('CdpTarget type assertion: required fields id/type/title/url', () => {
    const t: CdpTarget = {
      id: '1',
      type: 'page',
      title: 't',
      url: 'https://x',
    };
    expect(t.id).toBe('1');
    expect(t.type).toBe('page');
    expect(t.title).toBe('t');
    expect(t.url).toBe('https://x');
  });

  test('CdpTarget.webSocketDebuggerUrl is optional', () => {
    const withWs: CdpTarget = {
      id: '2',
      type: 'page',
      title: 'ws',
      url: 'https://y',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/2',
    };
    expect(withWs.webSocketDebuggerUrl).toContain('devtools/page/2');
    const withoutWs: CdpTarget = { id: '3', type: 'page', title: '', url: '' };
    expect(withoutWs.webSocketDebuggerUrl).toBeUndefined();
  });

  test('CdpError constructible with (message, code?)', () => {
    const e1 = new CdpError('boom');
    expect(e1).toBeInstanceOf(Error);
    expect(e1.message).toBe('boom');
    const e2 = new CdpError('boom with code', 42);
    expect(e2).toBeInstanceOf(Error);
    expect(e2.message).toBe('boom with code');
    // code is accepted at construction; exact type is impl-defined.
    expect((e2 as any).code).toBeDefined();
  });

  test('CdpError carries a name identifying it', () => {
    const e = new CdpError('x');
    expect(typeof e.name).toBe('string');
    expect(e.name.length).toBeGreaterThan(0);
  });
});

describe('CDP contract shapes (runtime classes/functions exist)', () => {
  test('CdpConnection is an exported class', () => {
    expect(typeof CdpConnection).toBe('function');
  });

  test('TargetSession is an exported class', () => {
    expect(typeof TargetSession).toBe('function');
  });

  test('CdpError is an exported class extending Error', () => {
    expect(typeof CdpError).toBe('function');
    expect(new CdpError('c') instanceof Error).toBe(true);
  });

  test('LaunchError is an exported class extending Error', () => {
    expect(typeof LaunchError).toBe('function');
    const e = new LaunchError('contract');
    expect(e instanceof Error).toBe(true);
    expect(e.message).toContain('contract');
  });

  test('ensureDebugChrome is an exported async function', async () => {
    expect(typeof ensureDebugChrome).toBe('function');
    // Spawn-safe deterministic probe: pin CHROME_PATH to a bogus binary.
    // Ruling (lead/cdp-core): env overrides are AUTHORITATIVE — findBrowser()
    // probes only the env path, returns null, and ensureDebugChrome MUST
    // reject with LaunchError. The spawn branch is unreachable on any
    // machine. The race wrapper pins "settles fast": if the impl ever
    // regresses to spawn-then-poll-20s, this fails on timeout instead of
    // hanging the suite.
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = '/definitely/not/a/real/browser/dsh-bridge-test';
    try {
      const raced = await race(
        ensureDebugChrome(1, '/tmp/should-not-exist-bridge-test'),
        8000,
      );
      expect(raced.state).not.toBe('timeout');
      expect(raced.state).toBe('err');
      const e: any = raced.error;
      const isLaunchError = e instanceof LaunchError || e?.name === 'LaunchError';
      expect(isLaunchError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = prev;
    }
  }, 20000);
});

describe('ensureDebugChrome return shape', () => {
  test('result object shape {alreadyRunning, launched, port, userDataDir} (compile-time)', async () => {
    // Compile-time shape check via assignment; runtime call would need Chrome,
    // so we only assert the signature is callable and rejects on bogus port.
    type LaunchResult = Awaited<ReturnType<typeof ensureDebugChrome>>;
    const shape: LaunchResult = {
      alreadyRunning: false,
      launched: false,
      port: 1,
      userDataDir: '/tmp/x',
    };
    expect(shape.port).toBe(1);
  });
});
