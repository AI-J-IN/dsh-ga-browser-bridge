/**
 * tests/launch.test.ts — ensureDebugChrome contract tests WITHOUT spawning
 * browsers.
 *
 * Two layers:
 *  1. A pure local helper (decideLaunch, in tests/setup.ts) pins the decision
 *     table ensureDebugChrome must implement:
 *       - port open                 -> reuse (alreadyRunning=true)
 *       - port closed + chrome live -> LaunchError (ambiguous state; must
 *         NOT spawn a second instance on a locked profile)
 *       - port closed + no chrome   -> launch fresh
 *  2. The real ensureDebugChrome is called with a bogus closed port (1) AND
 *     a bogus CHROME_PATH. Ruling (lead/cdp-core): CHROME_PATH/DSH_BROWSER_PATH
 *     are AUTHORITATIVE when set — a bogus value makes findBrowser() return
 *     null, so the impl MUST throw LaunchError ("No Chrome... found") and can
 *     never reach the spawn path. Deterministic on every machine. A race
 *     wrapper additionally pins "settles fast": if the impl ever regresses to
 *     spawn-then-poll-20s, the test fails on timeout instead of hanging.
 *
 * RED note: src/cdp/launcher was unwritten when this file was authored; the
 * static import failed at module load. Expected red.
 */
import { LaunchError } from '@cdp/launcher';
import { decideLaunch } from './setup';

describe('launch decision table (local pure helper)', () => {
  test('port open -> reuse, alreadyRunning=true, launched=false', () => {
    const r = decideLaunch({ portOpen: true, chromeRunning: true });
    expect(r).toEqual({ action: 'reuse', alreadyRunning: true, launched: false });
  });

  test('port closed + chrome running -> throw (LaunchError case)', () => {
    const r = decideLaunch({ portOpen: false, chromeRunning: true });
    expect(r.action).toBe('throw');
    expect(r.launched).toBe(false);
  });

  test('port closed + no chrome -> launch', () => {
    const r = decideLaunch({ portOpen: false, chromeRunning: false });
    expect(r).toEqual({ action: 'launch', alreadyRunning: false, launched: true });
  });
});

/**
 * Race a promise against a wall-clock deadline so a slow/hanging impl can
 * never wedge the suite. Cleanable: as soon as the race settles (either
 * branch), the timeout timer is cleared so no lingering handle keeps Jest
 * from exiting.
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

describe('ensureDebugChrome contract (spawn-safe on any machine)', () => {
  const BAD_DIR = '/tmp/definitely-not-a-real-profile-dsh-bridge-test';
  const BOGUS_BROWSER = '/definitely/not/a/real/browser/dsh-bridge-test';

  test('bogus closed port + bogus CHROME_PATH (authoritative): rejects fast with LaunchError — never spawns', async () => {
    const mod = await import('@cdp/launcher');
    expect(typeof mod.ensureDebugChrome).toBe('function');

    // Pin CHROME_PATH to a nonexistent binary. Ruling: env overrides are
    // authoritative — findBrowser() probes ONLY the env path, returns null,
    // and ensureDebugChrome MUST throw LaunchError ("No Chrome... found").
    // The spawn branch is unreachable; no browser is ever launched.
    const prev = process.env.CHROME_PATH;
    process.env.CHROME_PATH = BOGUS_BROWSER;
    try {
      const result = await race(mod.ensureDebugChrome(1, BAD_DIR), 8000);
      // Regression pin: a correct impl settles in well under 8s. If it ever
      // regresses to "spawn then poll 20s", this fails instead of hanging.
      expect(result.state).not.toBe('timeout');
      // Deterministic branch: rejection with LaunchError.
      expect(result.state).toBe('err');
      const e: any = result.error;
      const isLaunchError = e instanceof mod.LaunchError || e?.name === 'LaunchError';
      expect(isLaunchError).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CHROME_PATH;
      else process.env.CHROME_PATH = prev;
    }
  }, 20000);

  test('LaunchError is exported and constructible with (message, code?)', () => {
    const e = new LaunchError('port closed and chrome already running');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toContain('port closed');
    // code is accepted but optional — constructor must not require it.
    const e2 = new LaunchError('no code');
    expect(e2).toBeInstanceOf(Error);
  });
});
