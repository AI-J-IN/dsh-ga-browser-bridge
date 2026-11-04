# The DSH Browser Bridge extension

The plugin ships two transports. This document covers the **extension**
transport, which is the only way to drive the Chrome you *already have open*.

| | Extension transport (this doc) | CDP debug-port transport |
|---|---|---|
| Drives your already-open Chrome | **Yes** | No — the port only exists from launch time |
| Works on Chrome 136+ | **Yes** | Only with a separate `--user-data-dir` |
| Keeps your existing logins | **Yes**, it is your normal browser | Only if you copy the profile over |
| Requires installing something | A browser extension (once) | Nothing |
| Good for | Everyday use | Headless, CI, servers, automation |

Background: since Chrome 136, `--remote-debugging-port` is silently ignored on
the **default** profile (no error, no port, no `DevToolsActivePort`), and a
running Chrome can never open the port after the fact. The extension sidesteps
both problems by using `chrome.debugger`, Chrome's own
[alternate transport](https://developer.chrome.com/docs/extensions/reference/api/debugger)
for the DevTools protocol — it controls the tab you are looking at, right now.

---

## 1. Install the extension (once)

The extension is the `extension/` folder in this repository. It is not on the
Chrome Web Store, so load it unpacked:

1. Get the files: `git clone https://github.com/AI-J-IN/dsh-ga-browser-bridge.git`
   (or download the repo ZIP and extract it).
2. **Copy the `extension` folder somewhere short and stable** (strongly
   recommended — see the warning below):
   ```powershell
   Copy-Item -Recurse -Force .\dsh-ga-browser-bridge\extension `
     "$env:LOCALAPPDATA\DSH-Browser-Bridge-Extension"
   ```
3. Open `chrome://extensions` in Chrome.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked** and select that folder — the one that **contains
   `manifest.json`** (e.g. `%LOCALAPPDATA%\DSH-Browser-Bridge-Extension`).
   Selecting the repository root, or its parent, fails with
   "manifest file is missing or unreadable".
6. The extension appears as **DSH Browser Bridge**. Pin it if you like.

> **Why copy it out of `node_modules`:** if you installed the plugin into a
> DSH profile, the natural-looking path is
> `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-ga-browser-bridge\extension`.
> That path is long and deeply nested (easy to select one level too high), and
> **reinstalling or rebuilding the profile can remove it**, leaving Chrome with
> a dead "unpacked" extension that silently stops connecting. A folder such as
> `%LOCALAPPDATA%\DSH-Browser-Bridge-Extension` survives all of that.

Chromium-based browsers work the same way (`edge://extensions`,
`brave://extensions`, …).

> The extension needs the `debugger` permission, so Chrome shows a **yellow
> "DSH Browser Bridge started debugging this browser" bar** while a tool is
> driving a tab. That bar is the visible price of controlling a browser you
> already have open; it disappears when the session detaches.

## 2. Check the connection

The plugin listens on `127.0.0.1:18789` (configurable, see below). The
extension dials **out** to it, so there is nothing to port-forward and no
inbound firewall rule to add.

1. Make sure DSH is running with this plugin mounted.
2. Click the extension's **Details → Extension options**.
3. The status line should read **Connected**. If it says disconnected, the
   panel shows the last error (usually: plugin not running, or a different
   port).

If you changed the port in the plugin config, set the same port in the
extension options.

## 3. Use it

Nothing else changes — the five tools work as documented in the main README:

```
browser_tabs        list / find / switch / create / close
browser_scan        simplified HTML or visible text of the current page
browser_execute_js  run JS in the page and get the value back
browser_cdp         raw CDP command passthrough
browser_cookies     cookies for the tab's origin, including HttpOnly
```

`tab_id` values in extension mode are `chrome.tabs` ids (numbers, returned as
strings). They are only meaningful in the current browser session.

## 4. Configuration

Plugin side (`cordis.patch.yml`):

```yaml
- insert:
    - id: ga-browser-bridge
      name: dsh-ga-browser-bridge
      config:
        transport: auto        # auto | extension | cdp
        extensionPort: 18789   # 0 disables the extension transport
```

- `auto` (default) — use the extension when it is connected, fall back to the
  CDP debug port otherwise.
- `extension` — require the extension; tools return a clear error when it is
  not connected. Recommended if you want the debug-port path to stay off.
- `cdp` — ignore any connected extension.

Extension side (options page, or `chrome.storage.local`): `host` and `port` of
the plugin's listener.

## 5. Limitations you should know

> **Before you test anything:** right after loading the extension you are
> probably still on `chrome://extensions`. **Chrome forbids any extension from
> driving its own internal pages**, so the first tool call there fails with
> `NON_DEBUGGABLE_PAGE`. That is not an install failure — switch to a normal
> website tab and try again.

| Limitation | Why |
|---|---|
| `chrome://` pages cannot be driven | `chrome://settings`, `chrome://extensions`, the Chrome Web Store, other extensions' pages and `devtools://` are all off-limits to `chrome.debugger`. Error code: `NON_DEBUGGABLE_PAGE`. |
| `Browser.*` / browser-level `Target.*` are unavailable | `chrome.debugger` attaches to a TAB, so only tab-scoped CDP domains exist. See the domain table below. |
| A yellow "started debugging" bar appears | Chrome requires it whenever `chrome.debugger` is attached. |
| A tab with DevTools already open cannot be driven | Chrome allows only one debugger per tab. Close DevTools for that tab. |
| Enterprise policy can block it | Machine policy may disable the `debugger` permission; the extension then reports `ATTACH_FAILED`. |
| The service worker can sleep | MV3 workers are unloaded when idle; the extension reconnects on demand, so the first call after a pause may take an extra moment. |
| Extension reload drops the session | Reloading/updating the extension disconnects it; reopen a tool call to reconnect. |

### Which CDP commands work in each transport

`browser_cdp` reaches different scopes depending on the transport — this is
the essential difference between them, not a bug.

| CDP domain | Extension mode | CDP debug-port mode |
|---|---|---|
| `Runtime.*` (`Runtime.evaluate`, …) | ✅ | ✅ |
| `Page.*` (`Page.navigate`, `Page.captureScreenshot`, …) | ✅ | ✅ |
| `Network.*` (`Network.enable`, `Network.getResponseBody`, …) | ✅ | ✅ |
| `DOM.*`, `CSS.*`, `Input.*`, `Emulation.*` | ✅ | ✅ |
| `Storage.*` | ✅ | ✅ |
| `Browser.*` (`Browser.getVersion`, …) | ❌ `'Browser.getVersion' wasn't found` | ✅ |
| `Target.*` at browser level | ❌ | ✅ |

**Why:** `chrome.debugger` attaches to a single tab, so the browser-level
target domain simply does not exist for it. If you need `Browser.*` (version
info, browser-level target management), use `transport: cdp` with a debug
port, or derive the same facts from a page command.

## 6. Troubleshooting

| Symptom | Fix |
|---|---|
| Options page says **Disconnected** | Start DSH with the plugin mounted; confirm the port matches the plugin's `extensionPort`. |
| `NO_EXTENSION` in a tool result | No extension socket. Open the options page and check status; click the extension icon to wake the worker. |
| `ATTACH_FAILED` | DevTools is open for that tab (close it), or policy forbids `debugger`. |
| `TIMEOUT` | The browser did not answer within 30 s — a modal dialog or a hung page can do this. |
| Tools still use the debug port | `transport` is `cdp`, or the extension never completed its handshake. Check `transport: auto` and the options page. |

## 7. Security notes

### `browser_cookies` returns far more than "the tab's origin"

The tool description says "cookies for the tab's origin", but in **extension
mode the underlying `chrome.cookies.getAll` can read every cookie the browser
holds** — including on pages with no host (e.g. `about:blank`), where no
origin filtering happens at all. In practice that includes Google/YouTube
`SID`/`__Secure-1PSID`, payment and OAuth session tokens, and every site you
are logged into.

This is the permission model, not a defect: the extension is declared with
`cookies` + `<all_urls>` so it can act on arbitrary sites. Treat tool output
as **credential material**:

- Do not paste cookie output into public issues, chats, or logs.
- When you are not using the bridge, **disable the extension** — a disabled
  extension cannot attach or read cookies, which removes the exposure entirely.
- Prefer `transport: cdp` if you only need page interaction: the debug-port
  path is scoped to the browser you launched for it.


- The listener binds **127.0.0.1 only**; it is not reachable from the network.
- The extension has `<all_urls>` host permission and `cookies`/`debugger`
  access. Install it only from this repository, after reading
  `extension/background.js` — it is a few hundred lines with no remote code
  loading and no outbound connections other than `ws://127.0.0.1:<port>`.
- The extension never uploads page content anywhere; everything is local.
