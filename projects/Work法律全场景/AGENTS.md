# Work 法律全场景：AI 工作事实

本文件只说明本地代码中已实现的流程和边界。项目状态、题目数量、尝试结果须查当前工作台 API；不能从旧记录或本文件推断。

## 规则和结构分别看哪里

- 项目内容要求：先看 `materials/出题规范.md`、`materials/评分规范.md` 和对应原文转录；本批场景分配看 `skill/首批筹备-LS场景出题规则.md`。
- Agent 出题方法：从 `skill/SKILL.md` 按其导航读取。Skill 负责指导内容设计，不负责扩展程序字段。
- 字段结构：由代码内容契约定义。出题步骤配置可选择 `work_legal_v1`，数据库保存契约标识和题目 JSON 结果，不保存一份可任意编辑的 Schema。结构和校验见 `server/authoring/work-contract.ts`。
- 改其他项目字段：不能只改 Skill 或数据库标识；须实现对应代码契约，并核对生成、校验、保存、作答、评分和导出是否接通。没有对应契约时，按现有通用格式处理，不猜测项目自定义字段。

## 当前流程边界

1. 入库与脱敏产物供后续出题使用；步骤显示成功只表示执行成功，不证明提取完整或脱敏无遗漏。
2. 出题（步骤 4）读取本题脱敏材料、当前项目 Skill、冻结的步骤配置和已有角色／场景／方向设置。Work 契约字段见 `server/authoring/work-contract.ts`；完整题包写入现有 JSON 结果及产物。结构校验不等于法律内容、难度或等级已获专家认可。
3. 作答（步骤 5）只收到题面、获准的脱敏附件、成果呈现约定和作答步骤提示词，不收到作答思路、标准答案、Rubric、既有答案、评分结果或项目 Skill。API provider 是纯文字请求／回复；Codex provider 走本机隔离 Agent，宿主 Skill、插件、MCP、浏览器、记忆和网络关闭，文件访问限本次 attempt 工作区。`deliverables` 只作为成果清单提示，不代表已创建实际文件或完成外部检索。
4. 独立评分（步骤 6）读取同版题面、Rubric、脱敏附件和匿名答案；不读取作答思路，默认不提供标答。代码负责输入绑定、格式和算术校验；考点是否满足仍须依据 Rubric 与答案证据判断。算术正确不等于专业评分正确。
5. 达标判断（步骤 7）按当前项目模型集合、阈值和有效评分作机械判定；步骤成功表示判定执行完，须再看 `decision` 才知道是否达标。不要把通过数量当成评分准确率。
6. 归档（步骤 8）只接受当前版本已达标的题目，复核版本和产物后调用 `projects/Work法律全场景/scripts/delivery.ts`。五件套内容稿、Harbor 六件套预备包、DOCX／Excel 与数据库归档状态是不同产物；生成或归档成功不代表已上传、真人专家确认或平台验收。

## 防止误判

- 报进度时分开写：执行状态、内容是否按规范核验、外部平台是否验收。不能用其中一项替代另外两项。
- 报分时先说明评分对象和依据；运行成功率、达标率、Rubric 算术正确率、专业准确率不是同一个指标。无证据的维度写“未核验”，不补造百分比或分数。
- 真实检索、专家确认、外部提交只有存在相应记录或文件时才标为完成。AI 模拟成果必须标明 AI，不称作真人专家成果。
- 改字段或流程前追踪：步骤配置 → 出题 Schema／校验 → JSONB 结果与题目版本 → 作答输入 → 评分输入 → 归档脚本。提示词里的要求不能证明代码已实现。
- 代码和文档可能与运行中的服务版本不同；需要判断当前运行效果时，查 API、attempt 和对应运行日志。静态文档或测试不能替代真实流程验收。

## 代码导航

- 出题契约：`server/authoring/work-contract.ts`；队列与冻结配置：`server/authoring/jobs.ts`。
- 作答输入与成果呈现：`server/answer-models/input.ts`、`server/answer-models/dispatch.ts`。
- 独立评分：`server/scoring/context.ts`、`server/scoring/executor.ts`；达标判定：`server/decisions/`。
- 归档校验与执行：`server/publishing/jobs.ts`、`projects/Work法律全场景/scripts/delivery.ts`。
- 模块细节分别见 `server/authoring/README.md`、`server/answer-models/README.md`、`server/scoring/README.md`、`server/decisions/README.md`、`server/publishing/README.md`。
