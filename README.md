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

---

## English

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

- DeepSeek Harness (desktop profile or any profile where you can install bundles)
- Node.js >= 18 (only needed to build; the published repo ships `dist/`)
- Google Chrome **or** Microsoft Edge
- **You must restart Chrome once** with the debug port the first time — or
  let the plugin do it (see Auto-launch). Chrome only opens the debug port at
  launch, so an already-running Chrome without the port must be restarted.

### Install

```bash
dsh plugin add github:<you>/dsh-ga-browser-bridge
```

The bundle's `cordis.patch.yml` is applied automatically (declared via
`dsh.bundle.patch` in `package.json`).

Manual alternative (clone + copy):

```bash
git clone https://github.com/<you>/dsh-ga-browser-bridge.git
cd dsh-ga-browser-bridge
npm install && npm run build
# copy the package dir into your profile's node_modules, then add the
# cordis.patch.yml insert row (see Configuration)
```

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

### Auto-launch & login state

When the plugin finds port 9222 closed it launches Chrome itself with
`--remote-debugging-port=9222` and **no `--user-data-dir` override**, so your
real profile (and every login) is reused. Two consequences:

1. If your Chrome is **already running without the debug port**, Chrome will
   not open the port on the existing process. The plugin then reports the
   exact fix: close all Chrome windows and let it relaunch (or set
   `DSH_BROWSER_USER_DATA_DIR` to a separate profile). It will **never kill
   your browser**.
2. The first relaunch restores your tabs (Chrome's own restore).

To launch manually instead (Windows):

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

macOS / Linux:

```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
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

### Development

```bash
npm install
npm run build     # tsc -> dist/
npm test          # jest (mocked CDP; no real Chrome needed)
```

### License

MIT

---

## 中文

### 为什么做这个

旧的 `ga-browser-bridge` 是四层串联：

```
DSH ──MCP(stdio)──> br_mcp.py ──HTTP──> GA master :18766 ──WS──> 扩展 ──CDP──> Chrome
```

任何一层断了整个链路就废了，而且需要装 GA 桌面端、捆绑的 Python
运行时、还要手动加载一个 Chrome 扩展。

本插件去掉全部三个依赖，直接对 CDP 说话：

```
DSH ──原生工具──> 插件 ──CDP (WebSocket)──> Chrome (--remote-debugging-port=9222)
```

### 特性

- 五个工具：`browser_tabs` / `browser_scan` / `browser_execute_js` /
  `browser_cdp` / `browser_cookies`
- 复用你的**默认 Chrome profile**——已登录的站点全部保持登录态
- 调试端口没开时自动拉起带端口的 Chrome
- `browser_cdp` 原始 CDP 透传：截图、可信输入、文件上传、跨域 iframe、
  shadow DOM
- 批量 CDP 命令，支持 `$N.path` 引用前序结果
- TypeScript + ESM，唯一运行时依赖 `ws`

### 前置条件

- DeepSeek Harness（desktop profile 或任何能装 bundle 的 profile）
- Node.js >= 18（仅构建需要；仓库发布物自带 `dist/`）
- Google Chrome 或 Microsoft Edge
- **首次使用需要重启一次 Chrome** 带调试端口（或交给插件自动拉起）。
  Chrome 只在启动那一刻开调试端口，已经在跑的实例无法事后补开。

### 安装

```bash
dsh plugin add github:<你的账号>/dsh-ga-browser-bridge
```

bundle 的 `cordis.patch.yml` 会自动生效（`package.json` 里
`dsh.bundle.patch` 声明）。

手动方式（clone + 拷贝）：

```bash
git clone https://github.com/<你的账号>/dsh-ga-browser-bridge.git
cd dsh-ga-browser-bridge
npm install && npm run build
# 把包目录拷进 profile 的 node_modules，再按「配置」一节加
# cordis.patch.yml 的 insert 行
```

### 配置

bundle 会自动往 profile composition 插入一行：

```yaml
- insert:
    - id: ga-browser-bridge
      name: dsh-ga-browser-bridge
      config:
        # host: '127.0.0.1'
        # port: 9222
        # autoLaunchChrome: true
```

| 选项 | 默认 | 含义 |
|---|---|---|
| `host` | `127.0.0.1` | CDP 调试地址 |
| `port` | `9222` | CDP 调试端口 |
| `autoLaunchChrome` | `true` | 端口没开时自动拉起带 `--remote-debugging-port` 的 Chrome（复用默认 profile 保留登录态）。`false` = 快速失败并给出可复制的启动命令。 |

### 五个工具

名字、参数、返回结构都与旧桥一致。

**`browser_tabs`** — 列出 / 查找 / 切换 / 新建 / 关闭标签页

```jsonc
{ "action": "list" }                          // {"count":N,"tabs":[{id,title,url}]}
{ "action": "find", "url_pattern": "github" } // {"matched":N,"tabs":[...]}
{ "action": "switch", "tab_id": "12" }
{ "action": "create", "url": "https://x.com", "active": true }
{ "action": "close", "tab_id": "12" }
```

**`browser_scan`** — 当前页面的简化 HTML（去掉 script/style/noscript/
svg）；`text_only:true` 只返回可见文本；`maxchars`（默认 35000）截断。

**`browser_execute_js`** — 在页面里执行 JS，支持 `await`，返回求值结果。
（旧桥的 DOM-diff 监视本插件不提供。）

**`browser_cdp`** — 原始 CDP：`{method, params}` 单条，或 `{commands:[...]}`
批量，批量里可用 `$N.path` 引用前面的结果。

**`browser_cookies`** — 读取标签页来源的 cookie，**含 HttpOnly**。

### 自动拉起与登录态

插件发现 9222 没开时会自己拉起 Chrome，参数是
`--remote-debugging-port=9222` 且**不传 `--user-data-dir`**，因此复用你的
真实 profile（所有登录态都在）。两个后果：

1. 如果你的 Chrome **已经在跑但没开调试端口**，Chrome 不会给已有进程补开
   端口。插件会明确报错并给出解法：关掉所有 Chrome 窗口后重试（或设置
   `DSH_BROWSER_USER_DATA_DIR` 指向独立 profile）。插件**绝不会替你杀浏览器**。
2. 首次重开后 Chrome 会恢复你的标签页（Chrome 自身的恢复机制）。

想手动启动（Windows）：

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

macOS / Linux：

```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1
```

环境变量覆盖（优先级高于配置）：`DSH_BROWSER_PATH`（或 `CHROME_PATH`）、
`DSH_BROWSER_USER_DATA_DIR`、`DSH_BROWSER_PORT`。

### 不要同时挂两个桥

旧 `ga-browser-bridge` MCP 行和本插件注册**同名** `browser_*` 工具。装本
插件前，先把旧行（`serverName: ga-browser-bridge` / `br_mcp.py`）禁用或删除。

### 排错

| 现象 | 原因 / 解法 |
|---|---|
| `No browser tabs available` | Chrome 没带调试端口运行。交给自动拉起，或手动执行上面的命令。 |
| `Chrome is already running without a debug port` | 关掉所有 Chrome 窗口再试。插件不会替你杀浏览器。 |
| 工具在但调用全部超时 |别的进程占着 9222；`netstat -ano \| findstr 9222` 查一下，或换个 `port`。 |
| 登录态丢失 | 插件用独立 profile 拉起了 Chrome。设置 `DSH_BROWSER_USER_DATA_DIR` 指向你的真实 profile 目录，或干脆别覆盖。 |
| `browser_execute_js` 返回 `[error] ...` | 页面里 JS 抛异常，消息里带异常内容。把导航和动作拆成两次调用。 |

### 开发

```bash
npm install
npm run build     # tsc -> dist/
npm test          # jest（mock CDP，不需要真 Chrome）
```

### 许可证

MIT
