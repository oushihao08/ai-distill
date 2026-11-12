# web-agent：网页聊天（DeepSeek / Gemini）CDP 驱动

读者：写 worker “web agent” 执行器或排查网页聊天故障的工程师。本目录用**独立 Chrome 档案**经 Chrome DevTools Protocol 驱动 DeepSeek 网页与 Gemini 网页完成一次（或多轮）对话；零 npm 依赖（Bun `WebSocket`/`fetch`/`Bun.spawn`），不读取数据库、队列、`.env`，也不使用用户日常 Chrome。

## 文件职责

| 文件 | 职责 / 入口 | 调用方 |
| --- | --- | --- |
| `index.ts` | 公共入口：`createWebChatTransport`、`webBrowserStatus`、`webDoctor`、`webLogin`、`webCloseBrowser`、`WebAgentError`、`extractJsonFromReply`、`isLikelyTruncatedJson` | worker 执行器、CLI |
| `types.ts` | 站点/会话/传输接口，`WebAgentError{reason_code}` 与固定错误文案 | 全模块 |
| `cdp.ts` | 最小 CDP 客户端：请求/响应关联、事件、断线、超时、取消；浏览器级连接 + `Target.attachToTarget{flatten}` 多路复用 | `browser.ts`、`session.ts` |
| `browser.ts` | 专用 Chrome 生命周期：档案/端口/锁路径、启动与复用、状态、关闭、人工登录窗口 | `transport.ts`、`index.ts` |
| `transport.ts` | `createWebChatTransport()`：新建对话 target、等待输入框、应用选项；`probeProviderHealth()` 只读登录态探测 | `index.ts` |
| `session.ts` | `CdpChatSession`：上传、写入提示词、发送、多信号等待、读取回复、取消/超时 | `transport.ts` |
| `classify.ts` | 纯函数：登录/验证码/限额/繁忙文案与页面快照分类 | `session.ts`、`transport.ts` |
| `json-extract.ts` | `extractJsonFromReply()`、`isLikelyTruncatedJson()`、`JsonExtractError` | 调用方解析回复 |
| `sites/types.ts` | `WebSiteAdapter`：站点选择器/判定都是**页面内 JS 表达式字符串** | 站点适配 |
| `sites/dom-markdown.ts` | 页面内 DOM→Markdown 函数源码（保留 ``` 围栏、列表、表格、标题） | 各站点 `lastReply` |
| `sites/deepseek.ts`、`sites/gemini.ts` | 两个真实站点的表达式（可原样用 `bsk evaluate` 复核） | `transport.ts` |
| `sites/fake.ts`、`fake-chat-server.ts` | `provider:'fake'` 的适配器与本地假聊天页（`Bun.serve`，URL 由 `fake_url` 注入） | 测试、验证脚本 |
| `*.test.ts` | `cdp.test.ts`（假 CDP 服务器）、`json-extract.test.ts`、`classify.test.ts` | `bun test` |

端到端脚本：`scripts/verification/verify-web-agent.ts`（真实 Chrome + 假聊天页，使用独立临时档案）。

## 对外接口摘要

```ts
const transport=createWebChatTransport({root?,chromePath?,headless?,fake_url?});
const session=await transport.open('deepseek'|'gemini',{signal?,thinking?,model_label?}); // 全新对话
const reply=await session.ask({prompt,files?:[{name,content}]},{timeout_ms,signal?});     // {text,conversation_url,elapsed_ms}
await session.close();                                                                     // 关闭 target
```

- `open()` 默认**关闭联网搜索**（仅 DeepSeek 有该开关）；`thinking`（仅 DeepSeek 的 DeepThink）与 `model_label`（仅 Gemini 模型选择器）只在显式传入时改变站点默认，站点不支持的选项被忽略。
- 文件数超过站点上限、单文件超限或为空 → 直接抛 `web_upload_rejected`（不静默丢弃，由调用方打包后重试）。上传后等待站点确认**全部**文件就绪（解析完成）才发送。
- 同一会话的多次 `ask` 串行复用同一对话；同时最多会话数由调用方控制（验证脚本覆盖 6 个并发）。
- `root` 为存储根（默认 `server/paths.ts` 的 `storageDirectory()`）；档案与端口文件位于 `<root>/web-agent/`。
- `extractJsonFromReply(text)`：优先唯一 ```json 围栏；无围栏时整段必须可解析；多候选/截断/非 JSON 抛 `JsonExtractError`（`reason_code=web_reply_incomplete`，`json_reason` ∈ `empty|truncated|multiple_candidates|invalid_json|no_json`），不补全、不猜测。`isLikelyTruncatedJson(text)` 供调用方决定是否让模型“继续输出”。

## 数据流

1. `open()`：`ensureBrowser()` 读 `<root>/web-agent/browser.json` → 端口可连则复用；否则在 `browser.lock`（`wx` 原子创建，90 秒陈旧）内启动 Chrome，等 `profile/DevToolsActivePort`，写 `browser.json`（原子重命名）。其他进程等待同一实例。
2. 连接浏览器级 WebSocket → `Target.createTarget({newWindow,background})` → `attachToTarget{flatten}` → `Page.enable`、`Emulation.setFocusEmulationEnabled` → 等聊天输入框（登录页/验证码立即抛错）→ 应用选项。
3. `ask()`：基线 `chatState` → 文件（DeepSeek：`DOM.setFileInputFiles`；Gemini：可信点击菜单项 + `Page.fileChooserOpened`）→ 等全部附件就绪 → 写入提示词（≤16,000 字符用 `Input.insertText`，更长或校验不符时用站点表达式一次性写值并派发 `input` 事件；实测 `Input.insertText` 随长度超线性变慢：220KB 约 20 秒，写值约 30ms）并核对非空白字符数 → 点击发送并确认消息已提交 → 多信号等待（生成中标志消失 + 站点完成信号 + 回复签名在 2 秒内不变；无完成信号则 6 秒）→ 页面内表达式读取最后一条助手回复为 Markdown。
4. 取消：`AbortSignal` → 点击停止 → 关闭 target → `web_cancelled`；超时：点击停止 → `web_timeout`（会话保留，由调用方 `close()`）。
5. 上传文件先写入 `<root>/web-agent/tmp/up-*`（目录 0700、文件 0600），`ask` 结束后删除。

## reason_code

| reason_code | 含义 | 典型来源 |
| --- | --- | --- |
| `web_login_required` | 页面是登录页/出现登录入口 | 专用档案未登录或登录过期 |
| `web_challenge_required` | 验证码/风控验证 | 验证码元素/文案、`google.com/sorry/` |
| `web_rate_limited` | 站点提示限额/过于频繁 | toast、弹窗或短回复文案 |
| `web_busy` | 站点提示服务繁忙/出错 | toast、弹窗或短回复文案（如“服务器繁忙，请稍后再试”） |
| `web_timeout` | 页面未就绪或回复未在 `timeout_ms` 内结束；CDP 命令无响应 | 网络慢、站点卡住 |
| `web_ui_changed` | 选择器/表达式失效、发送后消息未提交、提示词未完整写入、未出现助手回复 | 站点改版 |
| `web_browser_unavailable` | 找不到/无法启动 Chrome、调试连接断开、target 已关闭 | 浏览器被关闭、页面崩溃 |
| `web_reply_incomplete` | 回复为空；或 `extractJsonFromReply` 判定截断/不可用 | 生成中断 |
| `web_upload_rejected` | 文件数/大小超限、站点拒绝格式或解析失败（如 DeepSeek “No text extracted”） | 上传 |
| `web_cancelled` | 调用方取消 | `AbortSignal` |

命中登录/验证码/限额/繁忙时**只抛错并停止**，不尝试绕过、不点击任何验证控件。错误信息不含提示词、回复正文、文件内容或凭证。

## 怎样登录与排错

1. 登录（只需做一次，之后档案保留登录态）：确保专用浏览器未运行（`webCloseBrowser()`），调用 `webLogin('deepseek'|'gemini')`。它用 `open -n -W -a "Google Chrome"` 启动**不带远程调试端口**的同档案前台窗口（避免自动化标记影响 Google 登录）；在窗口内手动登录后用 **Cmd+Q 退出该 Chrome**，函数才返回。专用浏览器正在运行时 `webLogin` 会拒绝（同一档案不能被两个实例同时使用）。
2. 体检：`webDoctor()` 必要时启动专用浏览器，逐站点开新 target 判断登录态后关闭，返回 `logged_in|login_required|challenge|unknown`，不发送消息。
3. 看状态：`webBrowserStatus()`；`<root>/web-agent/browser.json` 是端口文件；Chrome 异常退出后端口文件陈旧时 `ensureBrowser` 会自动重启。
4. 常见现象：
   - `web_login_required`：重新 `webLogin`；
   - `web_challenge_required`/`web_rate_limited`：先人工在专用档案窗口处理或等待，不要让程序重试轰炸；
   - `web_ui_changed`：站点改版，用 `bsk evaluate` 逐条复核 `sites/*.ts` 的表达式并修正；
   - 残留窗口：worker 崩溃可能遗留 target，`webCloseBrowser()` 后重启即可清除。

## 运行影响

- 会启动一个后台 Chrome（macOS：`open -g -j -n -a "Google Chrome"` + `--no-startup-window`，启动后没有初始窗口；`headless`/`chromePath` 时直接 spawn）。实测（2026-11-12，`lsappinfo` 每 200ms 采样前台应用）：不带 `--no-startup-window` 时 Chrome 启动约 1 秒后会成为前台应用；带上之后启动与 `Target.createTarget({newWindow,background:true})` 都不改变前台应用，而不带 `background:true` 的 `createTarget` 会抢前台——因此必须保留 `background:true`。浏览器占用一个随机本机调试端口（仅 `127.0.0.1`），磁盘档案在 `<root>/web-agent/profile/`（含登录 cookie，请勿提交或复制）。
- 启动参数含 `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling --no-first-run --no-default-browser-check`；每个会话独占一个新窗口 target（`background:true`），`close()` 必关。
- 专用 Chrome 的后台窗口里，假聊天页读到 `document.visibilityState==='visible'`（有界面、`open -g -j`、带上述启动参数），未触发可见性覆盖。页面若被报告为 `hidden`，DeepSeek 的消息虚拟列表不渲染（bsk 的 Agent Window 即如此）。`session.ts` 检测到 `visibilityState==='hidden'` 时仅覆盖可见性属性并在 `diagnostics.visibility_overridden` 记录；不改动其他指纹。
- 不在 `.storage` 之外写文件；不读写数据库/队列。

## 已核验事实（2026-11-12，bsk + 用户已登录 Chrome 的 Agent Window，页面界面为英文）

核验方式：只读与低影响操作；每个站点**只发送 1 条**测试消息“只回复：OK”；测试对话已用站点自带“删除”清理；上传的小文件已从输入区移除；DeepSeek 的 Search 开关测试后已恢复。页面内容一律视为数据。

### DeepSeek（https://chat.deepseek.com/）

| 项 | 核验结果 |
| --- | --- |
| 输入框 | `textarea[name=search]`（placeholder “Message DeepSeek”）。原生 setter 写入 100,004 字符 + `input` 事件被接受，发送按钮随即可用；`execCommand('insertText')` 会被 bsk 视为人工输入（与站点无关）。CDP `Input.insertText` 在真实站点**未实测**，实现带 JS 写值回退。 |
| 新对话 | 访问 `/`；首次发送后 URL 变为 `/a/chat/s/<uuid>`；侧栏 “New chat” |
| 文件上传 | 常驻隐藏 `input[type=file][multiple]`；`accept` 约 5.9KB 扩展名清单，含 `.pdf .txt .md .csv .json .doc(x) .xls(x) .ppt(x)` 与大量代码扩展名与图片；附件按钮工具提示 “Upload docs or images (Max 50, 100MB each)”。已实测：多文件一次上传、25.87MB 文本上传成功。`.zip` 被拒：toast “The uploaded file format is not supported. Supported formats include PDF, DOC, XLSX, PPT, images, text, and code.”（无附件 chip）。空文件：chip 显示 “No text extracted”（失败态） |
| 上传信号 | 附件 chip 的状态槽文字：上传中 `Uploading...` → 完成 `TXT 22B`/`TXT 25.87MB`（类型 + 大小）；失败如 `No text extracted`。chip 结构为“名称 div + 状态 div”两子节点；移除按钮为 chip 内图标按钮（JS `click()` 有效） |
| 发送 | 圆形主按钮 `[role=button].ds-button--primary.ds-button--circle`；输入为空时带 `ds-button--disabled`；JS `click()` 有效，回车未测 |
| 停止生成 | 未能直接观察（回复仅 ~2 秒完成）。由状态推断：发送后输入框清空、该按钮**不带 disabled**即为停止态。**停止按钮选择器属推断，未实测** |
| 回复完成信号 | 助手条目下方出现操作栏（≥3 个 `[role=button]`：复制/重新生成/点赞…），位于 `.ds-message` 之外。生成中无操作栏为推断 |
| 回复读取 | 虚拟列表 `[data-virtual-list-item-key]`（用户条目键为负数且含 `.ds-collapsible-text`）；最终回复在 `.ds-markdown.ds-assistant-message-main-content`；思考内容在 `.ds-think-content`（读取时排除）。代码块 `.md-code-block`：横幅 `span` 为语言名（实测 `json`）、“Copy/Download” 按钮、`pre.textContent` 保留换行。剪贴板未使用 |
| 深度思考 / 联网搜索 | `.ds-toggle-button` “DeepThink”“Search”，`aria-pressed` 表示状态；JS `click()` 可切换（已测 Search 关→开恢复）。该账号两者默认均为开；程序默认把 Search 置关，`thinking` 显式传入才改 DeepThink |
| 模型选择 | 该界面未发现模型选择器（`model_label` 对 DeepSeek 被忽略） |
| 登录/限额 | 登录页特征（`/sign_in`、密码框）与限额/繁忙文案**未实测**（已登录账号无法触发），按常见文案推断 |

### Gemini（https://gemini.google.com/app）

| 项 | 核验结果 |
| --- | --- |
| 输入框 | `rich-textarea .ql-editor[contenteditable=true][role=textbox]`（aria-label “Enter a prompt for Gemini”）。该页强制 TrustedHTML：写入须用 DOM API（`textContent`/`createElement`），`innerHTML` 被拒。`textContent` + `InputEvent('input')` 被接受，发送按钮出现。CDP `Input.insertText` 在真实站点**未实测**，实现带 DOM API 回退 |
| 新对话 | 访问 `/app`；首次发送后 URL 变为 `/app/<16位hex>` |
| 文件上传 | 无常驻 file input。“Upload and tools”（`button[aria-label]`）→ 菜单项 `[data-test-id=local-images-files-uploader-button]`（“Upload files”），需**可信点击**触发文件选择器（bsk upload 同机制）；实现用 `Page.setInterceptFileChooserDialog` + `Page.fileChooserOpened` + `DOM.setFileInputFiles`。已实测：多文件一次上传、25.87MB 文本（约 27 秒，页面为后台）、`.bin` 被接受。数量上限 10、单文件 100MB 来自官方说明，**未实测** |
| 上传信号 | 每个文件一个 `uploader-file-preview`：上传中 chip 含 `.gem-attachment-content.loading`（名称为空）；完成后显示类型标签 + 去扩展名的名称，关闭按钮 `aria-label="close <名称>"`；失败 chip 的 `gem-attachment` 带 `gem-attachment-loading-error`（空文件实测）。存在失败/加载中的 chip 时发送按钮 `aria-disabled=true` |
| 发送 | `button[aria-label="Send message"]`（输入框非空或有附件时出现）；JS `click()` 有效 |
| 停止生成 | `button[aria-label="Stop response"]`（生成期间实测出现） |
| 回复完成信号 | 最后一个 `model-response` 的 `.response-footer` 带 `complete` 类，并出现 Good/Bad response、Redo、Copy 等操作按钮 |
| 回复读取 | 每轮 `.conversation-container` = `user-query` + `model-response`；回复在 `model-response message-content .markdown`（段落 `<p>`）。代码块 `code-block`：`.code-block-decoration span` 为语言名（实测 `CSS`），`pre > code[data-test-id=code-content]` 为代码；表格为 `table` |
| 模型选择 | `button[data-test-id=bard-mode-menu-button]`（aria-label “Open mode picker, currently Gemini Auto”）→ `gem-menu-item[role=menuitemradio][data-test-id^=bard-mode-option]`；该账号选项：“Auto / Adapts to your needs”、“Code and analysis / 4 Argon”，另有 “Thinking level” 子菜单（Low/Medium/High）。`model_label` 按子串匹配这些项；实现未对 `thinking` 映射到 Gemini |
| 联网搜索 | 无开关（由模型自动决定） |
| 登录态 | 已登录页含 `a[href*="accounts.google.com/SignOutOptions"]`；未登录页应含 `ServiceLogin` 链接（**未实测**，推断） |

### 通用观察

- Agent Window（后台窗口）中 `document.visibilityState==='hidden'`，DeepSeek 虚拟列表为空、Gemini 菜单动画停滞，直到被截图触发渲染；因此程序对自己的窗口使用 `--disable-backgrounding-occluded-windows` 与焦点模拟，并在检测到 hidden 时覆盖可见性（见“运行影响”）。该行为在真实专用档案 + 真实站点上仍需验证。
- Gemini 页面 `load` 事件可能 30 秒内不触发（`networkAlmostIdle`），因此以“输入框出现”而非 `load` 判定就绪。

## 自动化验证结果（2026-11-12）

- `bun test ./server/web-agent/cdp.test.ts ./server/web-agent/json-extract.test.ts ./server/web-agent/classify.test.ts`：29 项通过。
- `bun scripts/verification/verify-web-agent.ts`（真实本机 Chrome 后台有界面 + 本地假聊天页，独立临时档案）：11/11 通过——3 个传输并发冷启动只有 1 个主进程；3 文件（含二进制与中文名）按序上传且 sha256 一致；220KB 提示词 sha256 一致；表格/列表/代码围栏保留；多轮复用同一对话；取消关闭 target、超时为 `web_timeout`；6 会话并发互不串扰；新传输复用同一实例；会话结束后页面数回到基线且临时上传目录已删；繁忙/上传拒绝/文件数超限/空文件/登录页/验证码页分类正确；测试期间前台应用从未是专用 Chrome。
- 站点表达式另用 `bsk evaluate` 在两站点真实历史对话页只读复核：DeepSeek 的 `pageState/options/chatState/lastReply`（表格、加粗、列表、```json 围栏均正确还原，`extractJsonFromReply` 可解析）与 Gemini 的 `pageState/chatState/lastReply`（表格、标题、列表、代码围栏）可执行且结果合理；`attachments`/`sendReady`/`composerLength` 在空输入态返回 `[]/false/0`。

## 未验证项

- 真实站点在**专用档案已登录**条件下的端到端（`open → ask → 回复`）；需要用户先 `webLogin`。
- 真实站点上的 CDP `Input.insertText` 写入、可信点击发送/上传菜单、`DOM.setFileInputFiles`/`fileChooserOpened`。
- DeepSeek 停止按钮与“生成中无操作栏”；DeepSeek/Gemini 限额、繁忙、验证码、登录页的真实页面形态；Gemini 文件数/大小上限；DeepSeek 单条消息长度上限（已测 10 万字符输入框接受，未发送）。
- 站点长回复（≥数千字）的读取与 DeepSeek 虚拟列表在多轮长对话中卸载旧条目的影响（程序用条目键与计数同时比较）。

## 维护边界

- 站点选择器只放在 `sites/*.ts` 的表达式里；改版后用 `bsk evaluate` 复核，并更新本文“已核验事实”的日期。
- 不绕过登录、验证码、风控、限额；不新增依赖；不读取 cookie/凭证；不使用用户日常 Chrome 档案或窗口。
- `webLogin` 与自动化浏览器互斥；不要同时对同一档案启动两个实例。
- 本目录与 `scripts/verification/verify-web-agent.ts` 之外的文件（执行队列、数据库、CLI）由各自模块维护。
