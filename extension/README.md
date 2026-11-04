# DSH Browser Bridge — Chrome extension

An unpacked Manifest V3 extension that lets the
[DSH Browser Bridge plugin](../README.md) drive **the Chrome you already have
open**, with your existing logins, without restarting Chrome and without a
`--remote-debugging-port`.

## Why this exists

The plugin normally talks to Chrome over a debug port. That transport cannot
attach to an already-running Chrome, and Chrome 136+ silently ignores
`--remote-debugging-port` on the **default** profile. `chrome.debugger` is
Chrome's official alternate transport for the remote debugging protocol, so an
extension can drive the current browser instead — no restart, no debug port.

## How it connects

The extension is the **client**. A service worker cannot listen on a TCP port,
but it can open a WebSocket connection, so it dials **out**:

```
DSH plugin (Node) listens on ws://127.0.0.1:18789
        ▲
        │  the extension dials out (hello, then JSON-RPC requests/responses)
        │
Chrome MV3 service worker ── chrome.debugger ──► the tab you are looking at
```

The contract lives in [`../src/extension/protocol.ts`](../src/extension/protocol.ts)
(message shapes, method names, result shapes, protocol version 1, default port
18789). This extension implements that contract and nothing else.

## Load it

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension if you like; the toolbar badge shows `!` while
   disconnected and is empty while connected.
5. Click **Details → Extension options** to confirm host/port. Defaults are
   `127.0.0.1` and `18789`. Save only if your plugin runs elsewhere; the worker
   reconnects as soon as the setting changes.

Then start the plugin / DSH. The options page status line shows
`Connected to the DSH plugin` when the handshake has landed.

## What it asks for

| Permission | Why |
| --- | --- |
| `tabs` | list / get / create / activate / close / reload tabs |
| `debugger` | `chrome.debugger.attach` + `Runtime.evaluate` for `page.evaluate`, `page.snapshot`, `cdp.send` |
| `storage` | remember host + port in `chrome.storage.local` |
| `cookies` | `cookies.get` for the host-side `browser_cookies` tool |
| `alarms` | keepalive tick so the service worker is woken and the socket reopened |
| `host_permissions: <all_urls>` | the debugger and cookies APIs operate on whatever site the user has open |

There are **no content scripts** and no `scripting` permission:
`page.evaluate` goes through `chrome.debugger`'s `Runtime.evaluate`.

Chrome shows a one-time install warning naming "Read and change all your data
on all websites" and "Debugger". That is the cost of the transport.

## The yellow bar

While a debugger session is attached, Chrome shows a **yellow/amber
"DSH Browser Bridge started debugging this browser" bar** at the top of the
window, with a **Cancel** link.

- It is unavoidable: any `chrome.debugger.attach` shows it. It is the user's
  guarantee that a debugger is active — not a bug.
- It appears only for tabs in use. The worker attaches per request and
  **detaches when the last concurrent caller releases the tab** (refcount), so
  the bar disappears again after a burst of commands.
- Clicking **Cancel** detaches the session: the in-flight request fails with
  `ATTACH_FAILED` and the host is sent a `debugger.detached` event. The next
  request simply re-attaches.

## Limitations a user will notice

- **DevTools conflict.** Chrome allows exactly one debugger per tab. If DevTools
  is open on the target tab, `chrome.debugger.attach` fails with *"Another
  debugger is already attached…"*, surfaced as `ATTACH_FAILED` with a message
  asking you to close DevTools for that tab. Close DevTools and retry — nothing
  is lost.
- **Enterprise policy.** Managed Chrome can block
  `chrome.debugger` / `Debugger extension`/ force-install-only extensions; on
  such machines the extension either cannot be loaded or every attach fails.
  Ask your admin — there is no workaround from inside the extension.
- **Yellow bar on every attach** (see above), including quick flashes during
  rapid tool calls.
- **No privileged pages.** `chrome://`, the Chrome Web Store, other extensions'
  pages and the PDF viewer cannot be driven: `tabs.*` works, but
  `page.evaluate` / `page.snapshot` / `cdp.send` fail there.
- **Service worker lifetime.** MV3 kills the worker after ~30s idle. The socket
  is therefore re-opened on demand; a request that arrives right after a wake
  up may wait for the connect handshake, and a long idle period means the host
  sees the extension "disconnect" briefly (the plugin shows the socket as
  closed until the next dial). Backoff is 1s, 2s, 4s … capped at 30s, and a
  `chrome.alarms` tick plus the options page status poll wake the worker.
- **One browser profile at a time.** The extension lives in one profile; two
  profiles means two extension instances fighting over one server port. Run
  one plugin instance per profile/port.
- **Loopback/LAN only.** `ws://` (not `wss://`) to the configured host. The
  plugin must bind a port reachable from this browser.
- **No file downloads or uploads through the browser UI.** Anything requiring a
  native picker is out of scope; use CDP methods that set files directly
  (`DOM.setFileInputFiles` via `cdp.send`) instead.
- **First attach after reload asks for nothing, but the debugger permission is
  granted at install.** Uninstalling and reloading resets the stored host/port
  to the defaults.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Status line stays "Disconnected" | Is the plugin running and listening on the configured port? Default `18789`. Try `Reconnect now`. |
| `ATTACH_FAILED` mentioning DevTools | Close DevTools for that tab. |
| Attach fails only on some tabs | `chrome://` / Web Store / extension pages cannot be debugged. |
| Works, then drops after ~30s idle | Expected MV3 behaviour; it reconnects on demand. |
| Nothing in the console | Open `chrome://extensions` → this extension → **service worker** to see the SW inspector log (`[dsh-bridge] …`). |

## Files

- `manifest.json` — MV3 manifest (no content scripts, no `scripting`)
- `background.js` — the whole service worker: connection, reconnect/backoff,
  keepalive, refcounted `chrome.debugger` sessions, every protocol method
- `options.html`, `options.js` — host/port settings and live status
- `icon128.png` — 128×128 icon
- `test/background.test.mjs` — Node harness: runs the worker in a `vm` against
  a fake `chrome` + fake WebSocket and asserts the protocol contract.
  Run `node extension/test/background.test.mjs` from the repo root.
