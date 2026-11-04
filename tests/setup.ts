/**
 * Shared test helpers for dsh-ga-browser-bridge.
 *
 * The old implementation (br_mcp.py) is the behavioral spec. This file
 * provides a fake CDP layer so tests never need a real Chrome.
 *
 * Envelope assumption (documented for the lead): a session/connection
 * `send()` returns the UNWRAPPED CDP result (the `result` field of the
 * wire message). E.g. Runtime.evaluate -> { result: { value } },
 * Page.captureScreenshot -> { data }, Network.getAllCookies -> { cookies }.
 * This matches src/tools' readers (`res?.result?.value`, `res?.cookies`).
 */

/** Shape mirrors src/cdp CdpTarget (contract). */
export interface FakeCdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

/** One recorded session.send() / connection.send() call. */
export interface RecordedCall {
  method: string;
  params?: any;
  timeoutMs?: number;
}

/** One recorded connection-level operation (attach/activate/create/close). */
export interface RecordedOp {
  op: string;
  targetId?: string;
  params?: any;
}

/**
 * Minimal in-test CdpError stand-in for contract-shape tests.
 * (The real one lives in src/cdp; this exists only so the contract test
 * file can construct an error with (message, code?) without a network.)
 */
export class FakeCdpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'CdpError';
    this.code = code;
  }
}

/** A canned response, or a function of the call params. */
export type CannedResponse = any | ((params: any, method: string) => any);

/**
 * Fake TargetSession: records every send() and returns canned responses
 * keyed by CDP method name.
 */
export class FakeTargetSession {
  readonly targetId: string;
  /** method -> canned response (or responder function). */
  public responses: Map<string, CannedResponse> = new Map();
  /** default response when method has no canned entry. */
  public defaultResponse: any = { result: {} };
  /** every send() call, in order. */
  public sent: RecordedCall[] = [];
  /** set to make send() reject (error path). */
  public throwOnMethod?: string;
  public errorToThrow?: Error;
  /** whether close() was called. */
  public closed = false;

  constructor(targetId: string) {
    this.targetId = targetId;
  }

  /** Register a canned response (or responder fn) for a CDP method. */
  on(method: string, response: CannedResponse): void {
    this.responses.set(method, response);
  }

  async send(method: string, params?: any, timeoutMs?: number): Promise<any> {
    this.sent.push({ method, params, timeoutMs });
    if (this.throwOnMethod === method) {
      throw this.errorToThrow ?? new Error(`fake failure for ${method}`);
    }
    const canned = this.responses.get(method) ?? this.defaultResponse;
    if (typeof canned === 'function') {
      return (canned as (p: any, m: string) => any)(params, method);
    }
    return canned;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Fake CdpConnection. listTabs() returns the configured targets;
 * attach(targetId) returns (and records) a FakeTargetSession.
 * send() (browser-level, used e.g. by Network.getAllCookies) is recorded
 * too. Also records the activate/create/close paths the tools may use.
 */
export class FakeCdpConnection {
  public tabs: FakeCdpTarget[] = [];
  /** sessions created via attach(), keyed by targetId. */
  public sessions: Map<string, FakeTargetSession> = new Map();
  /** ordered log of connection-level operations. */
  public ops: RecordedOp[] = [];
  /** every connection-level send(), in order. */
  public sent: RecordedCall[] = [];
  /** canned responses for connection-level send(). */
  public responses: Map<string, CannedResponse> = new Map();
  public defaultResponse: any = {};

  async listTabs(): Promise<FakeCdpTarget[]> {
    return this.tabs;
  }

  async attach(targetId: string): Promise<FakeTargetSession> {
    this.ops.push({ op: 'attach', targetId });
    let s = this.sessions.get(targetId);
    if (!s) {
      s = new FakeTargetSession(targetId);
      this.sessions.set(targetId, s);
    }
    return s;
  }

  /** The switch path (br_mcp.py _select / Target.activateTarget). */
  async activateTarget(targetId: string): Promise<void> {
    this.ops.push({ op: 'activateTarget', targetId });
  }

  /** The create path (Target.createTarget). */
  async createTarget(url: string): Promise<string> {
    this.ops.push({ op: 'createTarget', params: { url } });
    const id = `fake-tab-${this.ops.length}`;
    this.tabs.push({ id, type: 'page', title: '', url });
    return id;
  }

  /** The close path (Target.closeTarget / session close). */
  async closeTarget(targetId: string): Promise<boolean> {
    this.ops.push({ op: 'closeTarget', targetId });
    const i = this.tabs.findIndex((t) => t.id === targetId);
    if (i >= 0) this.tabs.splice(i, 1);
    const s = this.sessions.get(targetId);
    if (s) s.closed = true;
    return true;
  }

  /** Browser-level send (e.g. Network.getAllCookies). */
  async send(method: string, params?: any, timeoutMs?: number): Promise<any> {
    this.sent.push({ method, params, timeoutMs });
    const canned = this.responses.get(method) ?? this.defaultResponse;
    if (typeof canned === 'function') {
      return (canned as (p: any, m: string) => any)(params, method);
    }
    return canned;
  }

  on(method: string, response: CannedResponse): void {
    this.responses.set(method, response);
  }

  async close(): Promise<void> {
    this.ops.push({ op: 'close' });
  }
}

/**
 * The launch decision table ensureDebugChrome must implement
 * (br_mcp.py has no launcher; this pins the new plugin's contract):
 *   - port responding on 127.0.0.1  -> reuse (alreadyRunning=true)
 *   - port closed, chrome proc alive -> LaunchError (ambiguous state;
 *     must NOT spawn a second instance on a locked profile)
 *   - port closed, no chrome         -> launch fresh
 *
 * Defined here (tests only) so the contract is executable before
 * src/cdp/launcher lands.
 */
export function decideLaunch(input: {
  portOpen: boolean;
  chromeRunning: boolean;
}): { action: 'reuse' | 'launch' | 'throw'; alreadyRunning: boolean; launched: boolean } {
  if (input.portOpen) {
    return { action: 'reuse', alreadyRunning: true, launched: false };
  }
  if (input.chromeRunning) {
    return { action: 'throw', alreadyRunning: false, launched: false };
  }
  return { action: 'launch', alreadyRunning: false, launched: true };
}

/** The exact no-browser error prefix from br_mcp.py's _need_browser(). */
export const NO_BROWSER_ERROR_PREFIX = 'No browser tabs available';
