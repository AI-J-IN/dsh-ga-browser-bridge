# 给测试者的说明（Extension transport 试用）

感谢帮忙测试。这是一份**试用说明**，不是发布公告——扩展模式刚实现，
自动化测试全绿，但**真机验证还没做**，你的反馈正是这一步。

---

## 一、你要装什么

### 1. DSH 插件（必需）

```powershell
# 方式 A：CLI 装到 web profile（推荐，一条命令）
dsh plugin --profile web add github:AI-J-IN/dsh-ga-browser-bridge
dsh --profile web

# 方式 B：DSH 桌面版用户，手工放入 desktop profile
git clone https://github.com/AI-J-IN/dsh-ga-browser-bridge.git
Copy-Item -Recurse -Force dsh-ga-browser-bridge `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-ga-browser-bridge"
```

方式 B 还要把仓库里的 `cordis.patch.yml` 内容追加到
`%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`，然后**完整重启 DSH**。

> 注意：如果你之前挂过旧的 `ga-browser-bridge` MCP 行（`br_mcp.py`），
> **必须先禁用那一行**——两者注册同名工具，会冲突。

### 2. Chrome 扩展（必需，扩展模式的核心）

1. 打开 `chrome://extensions`
2. 右上角打开 **开发者模式**
3. 点 **加载已解压的扩展程序**
4. 选择仓库里的 **`extension`** 文件夹
   （⚠️ 不是仓库根目录，是里面那个含 `manifest.json` 的 `extension` 文件夹）
5. 装好后点扩展的「详情」→「扩展程序选项」，看状态是否 **Connected**

**关键点：不需要重启 Chrome，也不需要开任何调试端口。**
这正是扩展模式存在的意义——它直接驱动你现在这个已登录的浏览器。

---

## 二、请重点测这些

按重要性排序，每条都请告诉我**成功还是失败 + 原始返回**：

### A. 基础连通（最重要）
1. `browser_tabs` action=list —— 是否列出你**当前真实打开的所有标签页**？
   - 期望：`{"count":N,"tabs":[{"id":"...","title":"...","url":"..."}]}`
   - 关键：**数量和你实际开着的标签页一致吗？登录态还在吗？**

### B. 五个工具各测一次
2. `browser_scan` —— 打开一个普通网页（如新闻/文档），扫描内容是否正常？
3. `browser_execute_js` —— 执行 `document.title`，是否返回正确标题？
4. `browser_cdp` —— 执行 `Page.captureScreenshot`，是否返回 base64 图片数据？
5. `browser_cookies` —— 读取某个**已登录站点**，是否能看到含 HttpOnly 的 cookie？
6. `browser_tabs` create/switch/close —— 新建、切换、关闭标签页是否正常？

### C. 边界情况（这些最容易出问题）
7. **在 `chrome://settings` 页面上**调用 `browser_scan` —— 期望看到明确错误
   `NON_DEBUGGABLE_PAGE`（「此页面无法被扩展驱动」），**不是**含糊的失败
8. **某个标签页开着 DevTools** 时调用它 —— 期望 `ATTACH_FAILED` 并提示关 DevTools
9. **让浏览器 idle 几分钟后**（MV3 worker 会休眠）再调用 —— 是否还能自动连上？

---

## 三、你会看到什么（正常现象，不是 bug）

- **黄色提示条**「DSH Browser Bridge 正在调试此浏览器」—— Chrome 对
  `chrome.debugger` 的强制提示，会话结束会自动消失
- 首次调用可能比后续慢一点（service worker 唤醒）
- 如果你的浏览器是**公司统一管理的**，可能完全无法 attach
  （Chrome 155+ 企业策略），会返回 `POLICY_BLOCKED`

---

## 四、已知限制（不用报 bug）

| 限制 | 说明 |
|---|---|
| `chrome://` 页面无法操作 | Chrome 硬限制，任何扩展都做不到 |
| Chrome 应用商店页面无法操作 | 同上 |
| 其他扩展的页面无法操作 | 同上 |
| 开着 DevTools 的标签页无法操作 | Chrome 只允许一个调试器 |
| 企业受管浏览器可能完全不可用 | Chrome 155 策略限制 |
| `tab_id` 是数字（chrome.tabs id） | 与 CDP 模式的字符串 id 不同，但都是不透明 id |

---

## 五、出问题时请给我这些

1. **DSH 的原始错误信息**（工具返回的那一整串）
2. **扩展选项页的状态**（Connected / Disconnected + 最后错误）
3. 你的 **Chrome 版本**（`chrome://version`）
4. 你的 **DSH 版本**和用的是哪个 profile（web / desktop）
5. 如果是某个特定网站才失败，告诉我域名

---

## 六、如果扩展模式完全不行，退路是什么

插件保留了 **CDP 调试端口模式**，可以随时退回：

```yaml
config:
  transport: cdp   # 强制只用调试端口
  port: 9222
```

但注意：**Chrome 136+ 不允许在默认 profile 上开调试端口**，所以 CDP 模式需要：

```powershell
# 用脚本建一个独立 profile 并复制登录态（含 Local State，缺了 cookie 读不出来）
powershell -ExecutionPolicy Bypass -File scripts/setup-debug-profile.ps1 -Launch
```

但这是**退路**，不是目标——你要测的是扩展模式。
