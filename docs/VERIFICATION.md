# Verification Record — dsh-ga-browser-bridge

Date: 2026-11-03
Environment: Windows 11, Node v22.23.2, DSH desktop profile

## Automated gates (all green)

| Gate | Command | Result |
|---|---|---|
| Type check | `npx tsc --noEmit -p tsconfig.json` | exit 0, zero errors |
| Unit/integration tests | `npm test` (jest, mocked CDP) | **3 suites, 55/55 PASS**, clean exit (no open handles) |
| Build | `npm run build` | exit 0, `lib/` 14 JS files |
| Package import | `node -e "import('./lib/index.js')"` | exports: apply, inject, name, TOOLS, createToolContext, CdpConnection, ... |
| Launcher decision table | `ensureDebugChrome(9222)` with Chrome running w/o port | **LaunchError in 4 ms** (correct fast-fail; no spawn, no orphan, no 20 s spin) |

## End-to-end against a live CDP endpoint

Sandbox note: the DSH session sandbox denies `child_process.spawn`/`execSync`
(EPERM), so a *real* Chrome could not be launched from this session. An
in-process fake CDP server (HTTP /json surface + WebSocket flat protocol,
seeded with 2 tabs, a 3-cookie jar incl. an HttpOnly github.com cookie) was
started on 127.0.0.1:9222 and the plugin's five tools were exercised against
it through the real `lib/` build. The plugin cannot tell the difference —
the entire connection layer, protocol stack and tool logic ran for real.

Results (smoke run, `scripts/smoke.ts`):

| Tool | Call | Result |
|---|---|---|
| browser_tabs | list | `{"count":2,"tabs":[{id,title,url}...]}` — shape matches legacy br_mcp.py |
| browser_tabs | find url_pattern=github.com | `{"matched":1,...}` substring match |
| browser_tabs | create about:blank | full new target object (id 1004) |
| browser_tabs | switch 1004 | `true` (HTTP /json/activate) |
| browser_tabs | close 1004 | `true` (HTTP /json/close) |
| browser_scan | tab 1001, html | simplified HTML (script/style stripped) |
| browser_scan | tab 1001, text_only | visible text only |
| browser_execute_js | `return await Promise.resolve(6*7)` | `{"result":42}` — awaitPromise path works |
| browser_cdp | Page.captureScreenshot | base64 PNG data returned |
| browser_cdp | batch 2x Runtime.evaluate | ordered results array |
| browser_cookies | tab 1001 (github.com) | **sessionid (HttpOnly) + theme kept; tracker (.other-site.net) excluded** |

## Red→green discipline

- Initial suite: all 3 suites RED (Cannot find module '@cdp/types', TS2307)
  before any implementation existed.
- Implementation landed → 54/55; the 1 failure (browser_cookies returning
  `{"cookies":[]}`) exposed a real routing bug: `Network.getAllCookies` was
  sent on the page session while the test fake (and CDP semantics) treat it
  as a browser-level command. Fixed: connection-level first, session fallback.
- find with empty pattern: implementation returned 0 matches; br_mcp.py's
  Python semantics (`'' in url` is always true) return all tabs. Ruled: empty
  pattern = match all. Fixed and probe-verified against compiled lib.
- Jest "did not exit" warning: race() helpers left 8 s timers pending;
  fixed with clearTimeout in .finally(). Suite now exits cleanly.

## Known sandbox-only limitations (not plugin defects)

1. `child_process.spawn`/`execSync` are EPERM-blocked inside the DSH session
   sandbox. On a real user machine these work; the launcher's conservative
   `isBrowserProcessRunning` (probe failure → assume running) is exactly the
   right failure mode here: it fast-fails with a clear LaunchError instead of
   spawning into a profile lock.
2. Real-Chrome login-state verification (acceptance criterion 6) therefore
   could not be executed inside this sandbox. It is covered by design
   (default profile, no --user-data-dir override) and by the launcher tests;
   first run on an unsandboxed machine should confirm with the smoke script.

## How to re-verify on a normal machine

```bash
git clone <repo> && cd dsh-ga-browser-bridge
npm install && npm run build && npm test     # 55/55
# close Chrome, then:
node scripts/smoke.ts                        # auto-launch path
# or launch Chrome manually with --remote-debugging-port=9222 and rerun
```
