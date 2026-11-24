# 网页通道站点适配器（`server/web-agent/sites/`）

适用范围与读者：维护 `web-agent` 浏览器执行通道（DeepSeek、Gemini 及本地测试假站点）的工程师与排障 Agent。

## 职责与数据流

本目录将各对话站点的 DOM 探针、输入框写入、思考/联网开关、附件状态与回复 Markdown 提取封装为自包含的页面内 JS IIFE 字符串，供上级 [`session.ts`](../session.ts) 通过 CDP `Runtime.evaluate` 执行（也可通过 `bsk evaluate` 原样复核）。

## 关键文件

| 文件 | 职责与公开入口 |
| --- | --- |
| `types.ts` | 定义 `WebSiteAdapter`、`ChatStateInfo`、`AttachmentInfo` 契约与参数安全转义函数 `jsArg()` |
| `dom-markdown.ts` | 提供页面内 `DOM_MARKDOWN_FN`（`__waMarkdown(root)`），将助手回复 DOM 还原为保留标题、表格与自适应围栏代码块的 Markdown |
| `deepseek.ts` | `deepseekAdapter`：DeepSeek 网页端适配（基于 `ds-*` 稳定类与 ARIA 判定；注意后台 `hidden` 标签页虚拟列表不渲染消息） |
| `gemini.ts` | `geminiAdapter`：Gemini 网页端适配（富文本编辑器写入、上传气泡与 `footer.complete` 完成信号识别） |
| `fake.ts` | `fakeAdapter(baseUrl)` 与 `fakeChatPageHtml()`：仅供本地自动化测试使用的离线假聊天页实现（零外部站点请求） |

## 维护边界

- 所有表达式只读页面业务 DOM 或触发正常发送/开关按钮，严禁读取 Cookie/`localStorage`、严禁触碰登录表单或验证码挑战控件。
- 上层会话调度、浏览器生命周期与登录探针见 [`../README.md`](../README.md)。
