# dsh-ga-browser-bridge

Control your **real Chrome** (with all your login sessions intact) from
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) —
directly over the Chrome DevTools Protocol.

**No GenericAgent. No Python. No browser extension.** Just a DSH plugin that
talks CDP to the Chrome you already use.

> This plugin replaces the legacy `ga-browser-bridge` MCP bridge
> (`br_mcp.py` + GA master + `tmwd_cdp_bridge` extension). The five
> `browser_*` tools keep the **same names, same parameters, same return
> shapes**, so existing prompts and agent memories keep working.
>
> **Acknowledgment**: the design, the tool semantics, and the original
> real-browser-bridge concept come from the **GA (GenericAgent) project** —
> its `TMWebDriver` / `tmwd_cdp_bridge` extension / `br_mcp.py` bridge proved
> the approach and defined the `browser_*` tool contract this plugin keeps
> byte-compatible. Thanks to the GA project for the foundation.

> **中文文档**: [README.zh.md](./README.zh.md)

---


### Why

The old bridge chained four layers:

```
DSH ──MCP(stdio)──> br_mcp.py ──HTTP──> GA master :18766 ──WS──> extension ──CDP──> Chrome
```

Any broken layer killed the whole chain, and it required the GA desktop app,
a bundled Python runtime, and a manually loaded Chrome extension.

This plugin removes all three dependencies:

```
DSH ──native tools──> plugin ──CDP (WebSocket)──> Chrome (--remote-debugging-port=9222)
```

### Features

- Five tools: `browser_tabs`, `browser_scan`, `browser_execute_js`,
  `browser_cdp`, `browser_cookies`
- Reuses your **default Chrome profile** — everything you are already logged
  into keeps working
- Auto-launches Chrome with the debug port when it is closed
- Raw CDP passthrough (`browser_cdp`) for screenshots, trusted input, file
  upload, cross-origin iframes, shadow DOM
- Batch CDP commands with `$N.path` references to prior results
- TypeScript, ESM, single runtime dependency (`ws`)

### Prerequisites

- DeepSeek Harness (any profile; see Install for the desktop-App caveat)
- Google Chrome **or** Microsoft Edge
- Node.js >= 18 on the machine that runs DSH (the plugin is an ESM package;
  the DSH host provides the runtime — you only need Node present if you use
  the manual bundle install, which runs `pnpm install`)
- **You must restart Chrome once** with the debug port the first time — or
  let the plugin do it (see Auto-launch). Chrome only opens the debug port at
  launch, so an already-running Chrome without the port must be restarted.

### Install

The repo is a standard DSH bundle (`package.json` declares
`dsh.bundle.patch` → `cordis.patch.yml`), and the compiled output ships in
`lib/` — clone-and-use, no build step needed.

**Which install command works depends on which DSH surface you use**
(verified against DSH 0.2.1-rc.5):

| You use | Install command |
|---|---|
| CLI / `web` / `headless` / custom profile | `dsh plugin --profile <name> add github:AI-J-IN/dsh-ga-browser-bridge` |
| Desktop App (`desktop` profile) | See "Desktop App users" below |

```bash
# CLI / web / headless / custom profile — one command, bundle patch auto-applied
dsh plugin --profile web add github:AI-J-IN/dsh-ga-browser-bridge

# local directory (after git clone)
dsh plugin --profile web add ./dsh-ga-browser-bridge
```

**Desktop App users.** The `dsh` CLI refuses to manage the reserved
`desktop` profile (`profile "desktop" is managed exclusively by the Electron
application`), and the App's built-in bundle installer accepts npm-registry
URLs only — a GitHub tarball URL is not accepted. Two working options:

1. **Recommended: install into a CLI-managed profile** alongside the
   desktop App (profiles are independent; e.g. `dsh plugin --profile web
   add github:AI-J-IN/dsh-ga-browser-bridge`, then `dsh --profile web`).
2. **Manual bundle install into desktop** (about 3 minutes):
   ```powershell
   git clone https://github.com/AI-J-IN/dsh-ga-browser-bridge.git
   # copy the package dir into the desktop profile's node_modules
   Copy-Item -Recurse -Force dsh-ga-browser-bridge "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ga-browser-bridge"
   ```
   then append the bundle's `cordis.patch.yml` content (one insert row,
   see Configuration) to
   `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`, and restart the
   Desktop App. The row id `ga-browser-bridge` must not collide with the
   legacy MCP row — disable that row first (see next section).
   The package needs the `ws` module resolvable from the profile's
   node_modules (already present in shipped profiles; if missing, run
   `pnpm add ws` inside the profile directory).

> Note: `dsh plugin add` forwards to `pnpm` in the profile directory, so
> `github:user/repo` specs are resolved by pnpm. The plugin runtime itself
> runs inside the DSH host process (Node >= 22); a separate Node install is
> only needed for the manual bundle path, which runs `pnpm install`.

### Configuration

The bundle inserts one row into your profile composition:

```yaml
- insert:
    - id: ga-browser-bridge
      name: dsh-ga-browser-bridge
      config:
        # host: '127.0.0.1'
        # port: 9222
        # autoLaunchChrome: true
```

| Option | Default | Meaning |
|---|---|---|
| `host` | `127.0.0.1` | CDP debug host |
| `port` | `9222` | CDP debug port |
| `autoLaunchChrome` | `true` | When the port is closed, launch Chrome with `--remote-debugging-port` (reusing your default profile). `false` = fail fast with the exact command to run yourself. |

### The five tools

All names, parameters and return shapes match the legacy bridge.

**`browser_tabs`** — list / find / switch / create / close tabs

```jsonc
{ "action": "list" }                                  // {"count":N,"tabs":[{id,title,url}]}
{ "action": "find", "url_pattern": "github" }         // {"matched":N,"tabs":[...]}
{ "action": "switch", "tab_id": "12" }
{ "action": "create", "url": "https://x.com", "active": true }
{ "action": "close", "tab_id": "12" }
```

**`browser_scan`** — simplified HTML of the current page (script/style/
noscript/svg removed); `text_only:true` returns visible text;
`maxchars` (default 35000) truncates.

**`browser_execute_js`** — run JS in the page, `awaitPromise` supported,
returns the evaluated value. (The legacy DOM-diff monitor is not provided.)

**`browser_cdp`** — raw CDP: `{method, params}` or `{commands:[...]}` batch
with `$N.path` references to earlier results.

**`browser_cookies`** — cookies for the tab's origin, **including HttpOnly**.

### Chrome 136+ restriction (IMPORTANT)

**Chrome 136 and newer refuse to open a remote-debugging port on the DEFAULT
profile.** Passing `--remote-debugging-port` without a *separate*
`--user-data-dir` is **silently ignored**: no error, no port, no
`DevToolsActivePort` file — externally it looks exactly like a typo, which
makes this very hard to diagnose. (Official notice:
[Chrome for Developers — remote debugging switch change](https://developer.chrome.com/blog/remote-debugging-port))

Practical consequences:

- The plugin's auto-launch **cannot** reuse your everyday profile on Chrome
  136+. It detects the installed major version and fails fast with an explicit
  message instead of spawning a Chrome that can never open the port.
- Point the plugin at a **separate profile directory** via
  `DSH_BROWSER_USER_DATA_DIR`, or start Chrome yourself with
  `--user-data-dir=<separate dir>`.
- A separate profile starts with no logins. To carry sessions over, copy these
  from your real profile (Chrome closed): `Network\Cookies`, `Login Data`,
  `Login Data For Account`, `Web Data`, `Preferences`, `Secure Preferences`,
  `Bookmarks`, plus `User Data\Local State` — that last file holds the DPAPI
  key that decrypts the cookie database; without it the copied cookies are
  unreadable.

```bat
REM Windows: a dedicated debug profile
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data DSH" ^
  --no-first-run --no-default-browser-check
```

Then point the plugin at the same directory so auto-launch agrees:

```powershell
setx DSH_BROWSER_USER_DATA_DIR "%LOCALAPPDATA%\Google\Chrome\User Data DSH"
```

### Auto-launch & login state

When the plugin finds the debug port closed it launches Chrome itself with
`--remote-debugging-port`. On Chrome **&lt; 136** it reuses your real profile
(no `--user-data-dir`) so every login is preserved; on **136+** that is
impossible (see the section above), so it requires a separate profile.

1. If your Chrome is **already running without the debug port**, Chrome will
   not open the port on the existing process. The plugin then reports the
   exact fix: close all Chrome windows and let it relaunch (or set
   `DSH_BROWSER_USER_DATA_DIR` to a separate profile). It will **never kill
   your browser**.
2. The first relaunch restores your tabs (Chrome's own restore).

To launch manually instead (Windows) — include `--user-data-dir` on Chrome 136+,
otherwise the port silently never opens:

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data DSH"
```

macOS / Linux:

```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.config/google-chrome-dsh"
```

Environment overrides (take precedence over config): `DSH_BROWSER_PATH`
(or `CHROME_PATH`), `DSH_BROWSER_USER_DATA_DIR`, `DSH_BROWSER_PORT`.

### Do not mount both bridges

The legacy `ga-browser-bridge` MCP row and this plugin register the **same
`browser_*` tool names**. Disable or remove the legacy row
(`serverName: ga-browser-bridge` / `br_mcp.py`) from your
`cordis.patch.yml` before installing this plugin.

### Troubleshooting

| Symptom | Cause / Fix |
|---|---|
| `No browser tabs available` | Chrome not running with the debug port. Let auto-launch work, or run the manual command above. |
| `Chrome is already running without a debug port` | Close all Chrome windows, then retry. The plugin will not kill it for you. |
| Tool appears but every call times out | Another process owns port 9222; check `netstat -ano \| findstr 9222`, or set a different `port`. |
| Login state missing | The plugin launched Chrome with a separate profile. Set `DSH_BROWSER_USER_DATA_DIR` to your real profile dir, or don't override it at all. |
| `browser_execute_js` returns `[error] ...` | The page threw; the message contains the JS exception. Split navigation and action into two calls. |
| `error: profile "desktop" is managed exclusively by the Electron application` | DSH platform limitation, not a plugin bug: the `dsh` CLI cannot manage the desktop App's reserved profile. Install into a CLI-managed profile, or use the manual bundle steps in Install. |
| `install_bundle` times out with `/-/npm/v1/attestations/... ETIMEDOUT` | The App's bundle installer expects an npm registry URL; it does not accept GitHub tarball URLs. Use the CLI (`dsh plugin ... add github:...`) or the manual bundle steps. |
| Plugin installed but tools missing after restart | Tool rows register at startup only — fully restart the DSH App/session after installing. Also confirm the legacy `ga-browser-bridge` MCP row is disabled (same tool names). |
| DSH fails to activate: `Cannot read properties of null (reading 'host')` | Fixed in 0.1.1: the loader passes `null` config for an entry with no `config:` key. Update the plugin (or add an explicit `config: {}`). |
| `--remote-debugging-port` given but the port never opens, no error | Chrome 136+ restriction: a separate `--user-data-dir` is mandatory. See "Chrome 136+ restriction". |
| `'Network.getAllCookies' wasn't found` | Fixed in 0.1.1: Chrome 155 removed it; the plugin now uses `Storage.getCookies` (falls back on old Chrome). |
| `newTab` hangs / `GET /json/new` 405 | Fixed in 0.1.1: `/json/new` requires PUT. |
| `activate`/`close` fail with `Unexpected token 'T', "Target activated"` | Fixed in 0.1.1: those endpoints return plain text, not JSON. |

### Development

Contributor workflow (end users do not need this — `lib/` is committed):

```bash
npm install
npm run build     # tsc -> lib/ (only after changing src/)
npm test          # jest (mocked CDP; no real Chrome needed)
```

### License

MIT
