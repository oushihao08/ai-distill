# 网页执行器（web-executors）

面向维护者。本目录把“网页对话”接成现有三类任务的执行后端：材料脱敏（整包化名）、材料整理、出题（步骤4）。它与 `server/agent/`、`server/llm-api/` 并列，是 `execute(task)` 注入点的第三种实现；不新建队列、不新建结果表，入库仍由各自原有的编译器、接收转换和发布事务完成。浏览器操作在 [`../web-agent/`](../web-agent/README.md)。

## 文件与职责

| 文件 | 入口与职责 | 调用方 |
| --- | --- | --- |
| `chat-loop.ts` | `runWebJsonChat()`：同一对话内“提问→取回单个JSON→校验→反馈修正”；输出被截断时剥离 DOM 提取补上的尾围栏、附末尾 60 字锚点自动要求续写并拼接；每轮写长度/耗时/会话地址到私有目录 | 三个执行器 |
| `bundle.ts` | `bundleForUpload()`：Agent目录文件→上传文件；数量不超过站点上限则原样逐个上传，超出则按原序合并为带 `<<<<< FILE: 路径 \| bytes=N >>>>>` 边界的文本容器，不丢、不摘要、不截断；`WEB_UPLOAD_MAX_FILES` 为站点上限 | 三个执行器 |
| `schema-check.ts` | `assertMatchesSchema()`：JSON Schema 子集结构校验，让网页路径与Agent结构化输出获得等价的结构保证（只验结构，不做内容准入） | authoring.ts、preparation.ts |
| `redaction.ts` | `webMaterialExecutor()`：与 `api-redaction.ts` 同形；上传 `source.json`、逐份原文参考 `.txt`、`review-hints.json`、`plan-schema.json`（续作加 `resume-material-plan.json`）；支持模型只返回发生修改/删除的稀疏 `texts` 条目并由 `expandSparsePlanTexts` 按精确 `id` 补齐未改动原文（未知/重复 `id` 原样透传给编译器拦截），再用原 `compileAgentTextMaterialPlan` 校验并反馈修正；`validation-source.json` 等宿主私有文件不上传 | `material-library/redaction-runner.ts` |
| `preparation.ts` | `webPreparationExecutor()`：把整理提示词中“材料JSON”标记之后的数据作为 `materials.json` 上传，schema 作为 `schema.json`；校验回路为 `task.validate`（调用方传入 compileFixedPreparation） | `material-library/preparation.ts` |
| `authoring.ts` | `webAuthoringExecutor()`：与 `runAgent` 同形；上传 `input/` 下与Agent读取相同的文件（Skill及引用、附件、`input.json`、`delivery.json` 等，排除本机 `render-package.cjs`），回复中的单个JSON即 `result.json`，经 schema 结构校验和原 `validateDraft` 接收 | `authoring/jobs.ts`（provider='web'） |
| `common.ts` | 默认传输单例、与Agent同形的结果封装（`provider:'web'`、`returned_model:null`）、每轮私有记录 | 三个执行器 |
| `fake-transport.ts` | 测试用脚本化传输替身 | `*.test.ts` |
| `*.test.ts` | 单元测试：打包、结构校验、对话回路、三个执行器；不启动浏览器，不证明真实站点可用 | — |

## 数据流

任务（队列 `web` 通道，6个独立槽位）→ 原业务执行器准备同一份目录输入 → 本目录执行器上传文件+提示词，开一个**全新**网页对话 → 回复取回单个JSON（被截断则续写）→ 原校验器（脱敏：同一编译器；整理：`compileFixedPreparation`；出题：schema 结构 + `validateDraft`）→ 校验失败把具体错误回给同一对话修正（默认最多3次，同一回复重复即停止）→ 通过后交回原业务代码，走原发布事务入库。本地Agent无需做任何额外处理。

## 边界

- 网页没有本地文件系统、shell、检索脚本或项目工作目录；提示词会如实告知。出题能力与桌面端Codex不等价，差异见 `web-agent/README.md` 和任务验收记录。
- 网页不返回可核实的实际模型：结果里 `provider='web'`，`requested_model='web:<站点>'`，`returned_model=null`。
- 整理的逐图判断需要可读取图片的Agent，网页路径拒绝。
- 失败（登录/验证码/限额/超时/界面变化等）以 `reason_code` 落到原任务的失败记录（见 `web-agent/README.md` 的 reason_code 表），不自动换执行器重试。
