/**
 * browser_tabs — list/find/switch/create/close tabs.
 *
 * Behavioral spec: br_mcp.py tool_tabs():
 *  - list -> {"count": N, "tabs": [{id,title,url}]}
 *  - find -> {"matched": N, "tabs": [...]} (substring match on url via
 *    url_pattern or pattern)
 *  - switch -> needs tab_id ("[error] switch needs tab_id"), activates the
 *    target (conn.activateTarget) and remembers it as ctx's current tab
 *  - create -> url (default about:blank), active bool; does NOT need
 *    existing tabs; returns the created target
 *  - close -> needs tab_id, closes via conn.closeTarget
 *  - unknown action -> "[error] unknown action: X (list/find/switch/create/close)"
 *
 * Routing (plan A): activate/create/close go through the shared CdpConnection
 * as methods (conn.activateTarget / conn.createTarget / conn.closeTarget);
 * list/find read conn.listTabs(). The underlying @cdp/json functions exist
 * in the cdp layer but are invoked by CdpConnection internally — tools do
 * not import them.
 */
import { tabRow, type CdpLikeConnection } from './cdp.js';
import type { ToolContext } from './index.js';
import { errPrefix, noBrowserError, unexpectedError } from './errors.js';

const ACTIONS = 'list/find/switch/create/close';

/**
 * Plan-A routing: activate/create/close are CdpConnection methods (the cdp
 * layer implements them on top of @cdp/json; tests fake them on the
 * connection). The documented CdpConnection base type doesn't list them, so
 * we view the shared connection through this structural type.
 */
type TabOpsConnection = CdpLikeConnection;

export async function browser_tabs(
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<string> {
  try {
    const action = String(args?.action ?? 'list').toLowerCase();
    const conn = (await ctx.getConnection()) as unknown as TabOpsConnection;

    if (action === 'create') {
      // create does not need existing tabs (no listTabs gate; matching
      // br_mcp.py where create works regardless of sessions).
      const url = args?.url ?? 'about:blank';
      const active = boolArg(args?.active);
      const createdId: string = await conn.createTarget(url);
      if (active) {
        await conn.activateTarget(createdId);
        ctx.currentTabId = String(createdId);
      }
      // Prefer the full target row from a fresh listing; fall back to the
      // minimal {id, url} shape when the connection doesn't re-list it.
      const rows = await conn.listTabs();
      const created = rows.find((t) => String(t.id) === String(createdId));
      return JSON.stringify(created ?? { id: createdId, title: '', url });
    }

    // Every other action needs at least one tab.
    const tabs = await conn.listTabs();
    if (!tabs || tabs.length === 0) return noBrowserError();

    if (action === 'list') {
      const rows = tabs.map(tabRow);
      return JSON.stringify({ count: rows.length, tabs: rows });
    }
    if (action === 'find') {
      const pat = String(args?.url_pattern ?? args?.pattern ?? '');
      // Empty pattern matches every tab (br_mcp.py: `'' in url` is always
      // true in Python) — only filter when a pattern was given.
      const rows = tabs
        .filter((t) => pat === '' || String(t.url ?? '').includes(pat))
        .map(tabRow);
      return JSON.stringify({ matched: rows.length, tabs: rows });
    }
    if (action === 'switch') {
      const tid = args?.tab_id;
      if (tid === null || tid === undefined || String(tid) === '') {
        return errPrefix('switch needs tab_id');
      }
      const wanted = String(tid);
      const hit = tabs.find((t) => String(t.id) === wanted);
      if (!hit) {
        return errPrefix(`tab not found: ${wanted}`);
      }
      await conn.activateTarget(hit.id);
      ctx.currentTabId = String(hit.id);
      return JSON.stringify(true);
    }
    if (action === 'close') {
      const tid = args?.tab_id;
      if (tid === null || tid === undefined || String(tid) === '') {
        return errPrefix('close needs tab_id');
      }
      const wanted = String(tid);
      const hit = tabs.find((t) => String(t.id) === wanted);
      if (!hit) {
        return errPrefix(`tab not found: ${wanted}`);
      }
      const ok = await conn.closeTarget(hit.id);
      if (ctx.currentTabId === String(hit.id)) ctx.currentTabId = undefined;
      return JSON.stringify(ok);
    }
    return errPrefix(`unknown action: ${action} (${ACTIONS})`);
  } catch (e) {
    return unexpectedError(e);
  }
}

function boolArg(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  return Boolean(v);
}
