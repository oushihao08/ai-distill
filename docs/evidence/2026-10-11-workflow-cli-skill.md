# Workflow CLI 与 Skill 实施验收

日期：2026-10-11。范围：本机 CLI、操作 Skill、命令契约单测及真实题目1只读核对。未派发真实任务、调用业务模型、修改业务数据、迁移或重启服务。

## 实施结果

- `cli/index.ts`、`commands.ts`、`client.ts`：项目/题目/状态/规则/模型集合/脱敏文本/尝试/结果/返修/归档/Excel与产物下载，统一 JSON 信封和退出码。
- `.agents/skills/ai-distill-workflow/SKILL.md`：通用范围解析、服务端就绪检查、逐步派发、多模型任务跟踪、准确终点、异常与禁止隐式操作。
- 根 `package.json` 新增 `ai-distill` 命令，无新依赖；`tsconfig.json` 纳入 CLI。根导航、架构、文档索引和新目录 README 同步。
- 使用现有 API 与共享步骤注册表；未修改后端、Web、数据库表、队列、模型输入或评分算法。

## 自动验证

```sh
bun test ./cli/client.test.ts ./cli/commands.test.ts
```

结果：**25 pass、0 fail、128次断言**。使用注入 HTTP 夹具，不连接真实数据库或模型。

覆盖：本机地址与重定向限制；空/非法JSON响应和HTTP关联号；写请求不重试且保留结果未知；七步稳定key/ordinal；100题分组；后组失败保留已提交任务；明确范围和非法参数；脱敏文本边界；多模型任务ID及终态；30秒请求与1小时外层预算、中断/到期不取消任务；部分读取失败；无效评分及系统判定原样呈现；合成题目1到评分准确停止；合成多模型七步到显式归档/导出；独立产物下载与本机文件禁止覆盖。

初次红灯为实现模块尚不存在；随后通过。外层预算专项曾在100ms测试期限内超时，增加截止信号后同项通过，证明外层截止能结束正在等待的读取。

CLI定向严格类型检查通过：

```sh
./node_modules/.bin/tsc --noEmit --pretty false --strict --skipLibCheck --target ESNext --module ESNext --moduleResolution Bundler --types bun --lib ESNext,DOM,DOM.Iterable cli/index.ts cli/commands.ts cli/client.ts cli/client.test.ts cli/commands.test.ts
```

仓库整体 `tsc --noEmit` **未通过**：报错在现有 `scripts/` 与 `server/` 的旧类型/测试/返回值契约；没有 CLI 报错。本次未扩大到这些文件。曾误用 `bun test cli`，Bun名称匹配额外运行 `server/codex/client.test.ts`，其中5项日志断言失败；进程已结束。之后全部使用明确的两份 CLI 测试路径，不将该次广泛结果称为通过。

`bun run ai-distill --help` 与 `step list --json` 实际运行成功，展示七个可见步骤。差异空白检查通过。

## 真实题目1只读核对

通过本机默认 API 查询项目、题目列表、`workflow status` 与 `result show`。项目 ID：`b5041cbb-0e67-410c-92d2-02bc97837f52`；题目1 ID：`8e9840ac-2e7d-490c-b81c-f24c89e4b4f4`。

当次接口返回：两份当前附件；前六个可见步骤成功；归档等待且就绪；无活动尝试；系统达标结果 `accepted`，模型记录8/20、百分制40、阈值50、状态passed。这里只验证 CLI 能读取并保留服务端状态，**没有复核本题专业质量、历史评分合理性或重新计算达标**。

## 结论边界

CLI实现、定向单元测试、类型检查和真实只读接口已验证。合成流程验证命令层行为，不能证明真实业务执行器全链路、真实模型输出或 Codex 在各种自然语言指令下的自主遵循质量。操作Skill已静态核对命令、范围、停止点和错误规则；未另开模型会话做行为压力测试。真实重跑、带模型的完整验收和后端既有报错应单独安排。

## 后续验证与 Skill 澄清（2026-10-11）

- Skill 明确区分“每次 API 只派发一个步骤”和“Codex 在用户已授权的连续范围内逐步推进至指定终点”，避免把单步接口误解成整次任务只能执行一步；无需逐步等待用户确认。
- 再次运行 `bun test ./cli/client.test.ts ./cli/commands.test.ts`：25 pass、0 fail、128断言。CLI 定向严格类型检查及 `bun run ai-distill --help` 均成功。
- 题目1实时状态显示前六步及达标判定已有成功结果，分数8/20、40/100，低于阈值50；本轮通过 CLI 派发并等待归档尝试 `06e217a9-56dd-484c-82c6-7637ea247955`，ordinal 8 返回 `succeeded`。这是入队、worker处理、状态回读的真实末步验证，不代表前六步在本轮重新执行。
- 未创建项目Excel：该API按整个项目导出，当前项目有其他达标题目，不能将其包装成题目1单题导出验证。Excel映射仍由单元测试覆盖。
- 因题目1前序结果已经存在，本轮没有重置、重新调用模型或覆盖既有出题／作答／评分记录。真实全新七步重跑和Codex自主连续执行行为仍未验证。
