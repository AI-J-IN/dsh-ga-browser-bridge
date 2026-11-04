# dsh-ga-browser-bridge

控制你的**真实 Chrome**（所有登录会话保持）从
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）——
直接走 Chrome DevTools Protocol。

**运行时不需要 GenericAgent，不需要 Python，不需要浏览器扩展。**只有一个 DSH
插件，对你已在用的 Chrome 说 CDP。

> 本插件取代旧的 `ga-browser-bridge` MCP 桥
> （`br_mcp.py` + GA master + `tmwd_cdp_bridge` 扩展）。五个 `browser_*` 工具
> 保持**同名、同参数、同返回形状**，现有提示词与 agent 记忆继续可用。

> **致谢**：本插件的设计、工具语义与「真实浏览器桥」概念来自
> **[GA（GenericAgent）项目](https://github.com/lsdefine/GenericAgent)**——它的
> `TMWebDriver` / `tmwd_cdp_bridge` 扩展 / `br_mcp.py` 桥验证了这条路线，
> 并定义了本插件保持字节级兼容的 `browser_*` 工具契约。
> 感谢 GA 项目及其作者打下的基础。

---

> **English documentation**: [README.md](./README.md)

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
- **两种传输，同一套工具契约：**
  - **扩展模式**——直接驱动你**已经打开的** Chrome，沿用当前登录态，
    不用重启浏览器，也不受 Chrome 136+ 默认 profile 限制影响。只需装一次
    随仓库附带的扩展 → [docs/EXTENSION.md](docs/EXTENSION.md)
  - **CDP 调试端口模式**——无需安装额外东西；适合无头/CI/服务器；
    在 Chrome 136+ 上需要独立 profile
- 复用登录态：扩展模式直接用手上这个浏览器；CDP 模式通过复制 profile 实现
- 调试端口没开时自动拉起带端口的 Chrome（CDP 模式）
- `browser_cdp` 原始 CDP 透传：截图、可信输入、文件上传、跨域 iframe、
  shadow DOM
- 批量 CDP 命令，支持 `$N.path` 引用前序结果
- TypeScript + ESM，唯一运行时依赖 `ws`

### 该用哪种模式？

| 你的需求 | 用哪个 |
|---|---|
| 操作你现在正在用的、已登录的浏览器 | **扩展模式** |
| 不想装任何东西，或无头/CI/服务器场景 | **CDP 调试端口模式** |
| 两者都要（有扩展就优先，没有就回落） | `transport: auto`（默认） |

「为什么不能直接连我开着的 Chrome？」——答案就是扩展模式。
[docs/EXTENSION.md](docs/EXTENSION.md) 讲了安装步骤、会看到的黄色调试提示条，
以及各种限制。

> **当前状态**：扩展模式是新功能。自动化测试全绿（130/130，含真实
> localhost WebSocket 的桥测试），但**尚未在真实 Chrome 上由维护者验证过**。
> [docs/TESTING.md](docs/TESTING.md) 是试用指南——欢迎反馈哪些能用、哪些不能。

### 前置条件

- DeepSeek Harness（任意 profile；desktop 的限制见「安装」一节）
- Google Chrome 或 Microsoft Edge
- 运行 DSH 的机器上有 Node.js >= 18（插件是 ESM 包；DSH 宿主自带运行时——只有用「手工 bundle 安装」时才需要本机 Node，因为要跑 `pnpm install`）
- **首次使用需要重启一次 Chrome** 带调试端口（或交给插件自动拉起）。
  Chrome 只在启动那一刻开调试端口，已经在跑的实例无法事后补开。

### 安装

本仓库是标准 DSH bundle（`package.json` 声明 `dsh.bundle.patch` →
`cordis.patch.yml`），编译产物已入库（`lib/`）——clone 下来即可用，
无需构建。

**安装命令取决于你用哪个 DSH 入口**（已在 DSH 0.2.1-rc.5 实测）：

| 你用的入口 | 安装命令 |
|---|---|
| CLI / `web` / `headless` / 自定义 profile | `dsh plugin --profile <名字> add github:AI-J-IN/dsh-ga-browser-bridge` |
| 桌面 App（`desktop` profile） | 见下文「桌面 App 用户」 |

```bash
# CLI / web / headless / 自定义 profile —— 一条命令，bundle patch 自动生效
dsh plugin --profile web add github:AI-J-IN/dsh-ga-browser-bridge

# 本地目录（git clone 之后）
dsh plugin --profile web add ./dsh-ga-browser-bridge
```

**桌面 App 用户。** `dsh` CLI 拒绝管理保留的 `desktop` profile
（报错 `profile "desktop" is managed exclusively by the Electron
application`），而 App 内置的 bundle 安装器只认 npm registry URL
（不接受 GitHub tarball）。两条可行路径：

1. **推荐：装进 CLI 管理的 profile**（与桌面 App 并存，profile 相互独立）：
   `dsh plugin --profile web add github:AI-J-IN/dsh-ga-browser-bridge`，
   然后 `dsh --profile web` 使用。
2. **手工 bundle 安装到 desktop**（约 3 分钟）：
   ```powershell
   git clone https://github.com/AI-J-IN/dsh-ga-browser-bridge.git
   # 把包目录拷进 desktop profile 的 node_modules
   Copy-Item -Recurse -Force dsh-ga-browser-bridge "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ga-browser-bridge"
   ```
   再把本仓库 `cordis.patch.yml` 的内容（一条 insert 行，见「配置」
   一节）追加到
   `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，重启桌面 App。
   行 id `ga-browser-bridge` 不能与旧 MCP 行冲突——先禁用旧行（见下节）。
   包运行时需要能从 profile 的 node_modules 解析到 `ws` 模块（出厂 profile
   已自带；若缺失，在该 profile 目录里执行 `pnpm add ws`）。

> 注：`dsh plugin add` 实际是把参数转发给 profile 目录下的 pnpm，
> 因此 `github:user/repo` 这种说明符由 pnpm 解析。插件运行时跑在 DSH
> 宿主进程内（Node >= 22）；只有手工 bundle 路径需要本机另有 Node
> （它要跑 `pnpm install`）。

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

### Chrome 136+ 限制（重要）

**Chrome 136 及更新版本禁止在「默认 profile」上开启远程调试端口。** 只传
`--remote-debugging-port` 而不传**独立的** `--user-data-dir` 时，Chrome 会
**静默忽略**该参数：不报错、端口不开、也不生成 `DevToolsActivePort` 文件——
从外部看和「参数写错了」完全一样，极难排查。（官方说明：
[Chrome for Developers — 远程调试开关变更](https://developer.chrome.com/blog/remote-debugging-port?hl=zh-cn)）

实际影响：

- 在 Chrome 136+ 上，插件的 auto-launch **无法**复用你的日常 profile。现在它会
  检测已安装的主版本号，**快速失败并给出明确原因**，而不是启动一个注定开不了端口的 Chrome。
- 必须通过 `DSH_BROWSER_USER_DATA_DIR` 指向**独立 profile 目录**，或自己带
  `--user-data-dir=<独立目录>` 启动 Chrome。
- 独立 profile 初始没有任何登录态。想带上登录态，请在关闭 Chrome 后把这些文件
  从真实 profile 复制过去：`Network\Cookies`、`Login Data`、
  `Login Data For Account`、`Web Data`、`Preferences`、`Secure Preferences`、
  `Bookmarks`，以及 `User Data\Local State`——**最后这个文件保存解密 cookie
  数据库所需的 DPAPI 密钥，缺了它复制过去的 cookie 全都读不出来**。

```bat
REM Windows：建一个专用调试 profile
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --remote-debugging-address=127.0.0.1 ^
  --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data DSH" ^
  --no-first-run --no-default-browser-check
```

然后把同一个目录告诉插件，让 auto-launch 与之一致：

```powershell
setx DSH_BROWSER_USER_DATA_DIR "%LOCALAPPDATA%\Google\Chrome\User Data DSH"
```

### 自动拉起与登录态

插件发现调试端口没开时会自己拉起 Chrome，参数是 `--remote-debugging-port`。
在 Chrome **&lt; 136** 上它复用你的真实 profile（不传 `--user-data-dir`），所以
登录态全在；在 **136+** 上这不可能（见上一节），必须使用独立 profile。

1. 如果你的 Chrome **已经在跑但没开调试端口**，Chrome 不会给已有进程补开
   端口。插件会明确报错并给出解法：关掉所有 Chrome 窗口后重试（或设置
   `DSH_BROWSER_USER_DATA_DIR` 指向独立 profile）。插件**绝不会替你杀浏览器**。
   在 Chrome 136+ 上，报错还会额外说明「仅关闭浏览器没用，必须改用独立 profile」。
2. 首次重开后 Chrome 会恢复你的标签页（Chrome 自身的恢复机制）。

想手动启动（Windows）——Chrome 136+ 必须带 `--user-data-dir`，否则端口静默不开：

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 --user-data-dir="%LOCALAPPDATA%\Google\Chrome\User Data DSH"
```

macOS / Linux：

```bash
google-chrome --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$HOME/.config/google-chrome-dsh"
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
| 工具在但调用全部超时 | 别的进程占着 9222；`netstat -ano \| findstr 9222` 查一下，或换个 `port`。 |
| 登录态丢失 | 插件用独立 profile 拉起了 Chrome。设置 `DSH_BROWSER_USER_DATA_DIR` 指向你的真实 profile 目录，或干脆别覆盖。 |
| `browser_execute_js` 返回 `[error] ...` | 页面里 JS 抛异常，消息里带异常内容。把导航和动作拆成两次调用。 |
| `error: profile "desktop" is managed exclusively by the Electron application` | DSH 平台限制，不是插件 bug：CLI 无权管理桌面 App 保留的 desktop profile。改装到 CLI 管理的 profile，或按「安装」节的手工 bundle 步骤操作。 |
| `install_bundle` 卡在 `/-/npm/v1/attestations/... ETIMEDOUT` 超时 | App 内置 bundle 安装器要 npm registry URL，不接受 GitHub tarball URL。改用 CLI（`dsh plugin ... add github:...`）或手工 bundle 步骤。 |
| 插件装好了但重启后工具列表没有 | 工具行只在启动时注册——安装后要完整重启 DSH App/会话。同时确认旧的 `ga-browser-bridge` MCP 行已禁用（工具同名会冲突）。 |
| DSH 启动报 `Cannot read properties of null (reading 'host')` | 0.1.1 已修：条目没写 `config:` 时 loader 传的是 `null`。升级插件，或显式写 `config: {}`。 |
| 传了 `--remote-debugging-port` 但端口一直不开、也不报错 | Chrome 136+ 限制：必须带独立的 `--user-data-dir`。见「Chrome 136+ 限制」。 |
| `'Network.getAllCookies' wasn't found` | 0.1.1 已修：Chrome 155 移除了该方法，改用 `Storage.getCookies`（旧版 Chrome 自动回退）。 |
| `newTab` 卡住 / `GET /json/new` 返回 405 | 0.1.1 已修：`/json/new` 必须用 PUT。 |
| `activate`/`close` 报 `Unexpected token 'T', "Target activated"` | 0.1.1 已修：这两个端点返回纯文本，不是 JSON。 |

### 开发

贡献者流程（最终用户不需要——`lib/` 已入库）：

```bash
npm install
npm run build     # tsc -> lib/（改了 src/ 之后才需要）
npm test          # jest（mock CDP，不需要真 Chrome）
```

### 许可证

MIT
