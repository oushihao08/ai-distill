<!-- 文件职责：记录 2026-10-08-execution-review 的阶段复盘和当时证据边界。 -->
# ai-distill 执行复盘与功能台账

复盘日期：2026-10-08（北京时间）  
检查范围：实施计划、源码、验收记录、运行进程及本地 API 健康接口。  
更新：已完成优先修复并补充真实调用、单元测试和浏览器尺寸证据；整卷 v8 复验结束：OCR缓存全部复用，但最终残留检查未通过；题目1、题目3另在真实测试。

## 总体判断

完整目标是第四阶段的自动出题、模型作答、独立评分、有限返修、成果入库与导出。目前第一阶段已完成；第二阶段仍被整份 PDF 的脱敏实体检查失败阻断；第三阶段已完成本地资料与规则快照管理，但 Codex 客户端已实现并通过真实套餐调用，第三步固定规则加载已接入，国内模型作答分发器已连接 worker；skill 生成及一个题目的模型评分闭环未接入；第四阶段尚未实施。

此前“约完成 35%”是按已有基础设施估算的工作量比例，不是以验收权重计算的精确进度。完整八步端到端验收通过的题目数为 **0**。以后应以本台账中核心链路的验收情况更新进度。

## 执行中发现的问题

| ID | 问题 | 证据与状态 | 影响 |
|---|---|---|---|
| I01 | 整份 PDF 提取未通过 | **未解决，验证中**：v8 的 66 页全部复用，201次实体请求完成；最终12页仍记有 entity_residue，整卷失败，未作为通过脱敏材料发布 | 第二步不能验收通过 |
| I02 | 实体检查错误分类不足 | **已解决**：记录阶段、页/块索引及 invalid_json、source_mismatch、HTTP、30 分钟超时等安全诊断；不公开实体值 | 可定位失败与重试范围 |
| I03 | OCR 断点粒度不足 | **已解决（实现和单测）**：逐页私有检查点按来源及 OCR 配置隔离；中断复用、配置或来源变化不复用已通过测试。真实进程中断续跑尚未验收 | 已完成页不必重复识别 |
| I04 | Codex 客户端仍是占位实现 | **已解决**：ChatGPT 套餐登录、隔离执行及结构化输出已接入；真实 gpt-6.1-sol 调用 21.139 秒通过。出题等业务步骤仍待连接 | 底层执行器可用，不能据此标记出题闭环完成 |
| I05 | Codex 客户端测试未通过 | **已解决**：客户端 12 项测试通过，覆盖代理环境、事件、重连、超时、取消和产物校验；全量后端 459 项通过、0 失败；类型检查及构建通过 | 客户端不再处于 RED |
| I06 | UnoCSS 数值单位错误 | **已解决**：数字长度直接按 px；浏览器 logo 44×44、按钮与输入框均 36px；构建 CSS 及类型检查通过 | 数值尺寸与间距符合要求 |
| I07 | 未观察到常规 worker 进程 | **已解决（运行状态）**：已启动常驻 worker，主库当前无任务；临时 schema 的任务领取与终态有集成证据 | 服务已运行，主库真实题目处理尚未证明 |
| I08 | 模型参数缺少实际支持校验 | **部分解决**：Codex 依据本机模型能力缓存校验模型/推理档位；智谱校验当前适配器支持的协议。尚无所有国内模型的通用能力发现及真实试跑 | 不支持的配置被拒绝，其他提供商仍需扩展 |
| I09 | 验收文档与最新结果不一致 | **已解决（本次同步）**：复盘、优先计划、PDF 验收及主计划更新，明确 v8 最终失败及新题真实测试中和底层客户端/业务闭环边界 | 最终结果仍须在真实运行结束后回写 |
| I10 | 首期 AI 使用规则覆盖 | **已解决**：按用户授权修改本地活动副本、登记 draft v2，原始材料不变；外部资格仍为未核实 | 不再阻挡本地执行 |
| I11 | 当前没有 Git 提交基线 | **部分解决**：已保存私有源码恢复归档及 SHA-256；仓库仍无 HEAD，没有创建 Git 提交 | 可恢复归档，尚无提交级追溯 |

耗时方面，整卷扫描识别包含逐页 OCR 及其后的逐段实体检查；当前整卷验证记录 OCR/实体调用计数与耗时，仍不能精确回溯此前全部工作时间。

## 状态、难度与核心程度定义

- **已验收**：有记录证明所列功能范围实际通过；不代表相邻能力也已验收。
- **部分**：实现存在，但范围、真实数据验收或必要质量检查不完整。
- **未实现**：没有执行能力，或仍为占位代码。
- **缺陷**：已确认的行为不符合当前要求。
- **难度**：后续工程实施难度估计，低、中、高。
- **核心程度**：核心表示端到端出题评测必需；支撑表示运营或可追溯能力；体验表示界面一致性。

下表中的“关联模块”均相对于仓库根目录 `/Users/jack/Documents/codes/lvgou/ai-distill`。

## 完整功能台账

### 项目、资料与规则

| ID | 功能 | 状态 | 作用 | 关联模块 | 难度 | 核心程度 |
|---|---|---|---|---|---|---|
| F01 | 前后端及 worker 启动脚本 | 已验收；当前 API 与 worker 已启动 | 启动及复用本地服务 | `scripts/start-iterm.sh`、`server/index.ts`、`server/worker.ts` | 低 | 支撑 |
| F02 | PostgreSQL 连接及迁移 | 已验收 | 业务数据持久化 | `server/db.ts`、`server/migrate.ts`、`migrations/` | 中 | 核心 |
| F03 | 项目创建、编辑、删除 | 已验收 | 管理不同出题项目 | `server/app.ts`、`server/project-folders.ts`、`web/src/views/ProjectList.vue` | 中 | 核心 |
| F04 | 每期独立项目资料目录 | 已验收 | 分隔资料、skill、题目、输出和快照 | `projects/`、`projects/README.md` | 低 | 核心 |
| F05 | 按题目目录发现工作流 | 已验收 | 建立“项目－题目”工作流身份 | `server/project-folders.ts` | 中 | 核心 |
| F06 | 来源目录同步 | 已验收 | 发现新增和已变化的题目材料 | `server/project-folders.ts`、`server/app.ts` | 中 | 核心 |
| F07 | 单题详情及执行历史 | 已验收前两步 | 查看阶段、材料、结果、错误及尝试 | `web/src/views/WorkflowDetail.vue`、`server/app.ts` | 中 | 核心 |
| F08 | 显式删除单题 | 部分：接口能力存在，完整页面操作未验收 | 删除题目记录并保留可追溯历史 | `server/app.ts`、`web/src/views/WorkflowDetail.vue` | 低 | 支撑 |
| F09 | 题目材料增加、替换、删除 | 接口已验收，浏览器全流程未验收 | 修改单题 PDF 材料包 | `server/intake.ts`、`server/app.ts`、`web/src/components/MaterialEditor.vue` | 中 | 核心 |
| F10 | 原件保存、指纹与下载 | 已验收 | 保留原始材料并核对来源 | `server/intake.ts`、`server/app.ts`、`server/materials/` | 中 | 核心 |
| F11 | 材料版本与旧结果隔离 | 已验收前两步 | 阻止旧任务覆盖新材料版本 | `server/intake.ts`、`server/materials/jobs.ts`、`migrations/003_input_versions.sql` | 高 | 核心 |
| F12 | 八步状态和就绪数量 | 已验收展示、前两步及第三步规则加载 | 显示步骤统计并筛选可执行题目 | `server/project-folders.ts`、`web/src/views/ProjectDetail.vue` | 中 | 核心 |
| F13 | 步骤模型与推理强度设置 | 部分：Codex 模型/档位与智谱协议校验已接入 | 保存步骤设置并用于已接入任务快照 | `server/project-folders.ts`、`server/app.ts`、`web/src/components/StepSettings.vue` | 中 | 核心 |
| F14 | 项目规则资料管理 | 接口已验收，浏览器全流程未验收 | 管理每期大纲、评分标准和参考材料 | `server/rules.ts`、`server/rule-files.ts`、`web/src/components/rules/ProjectRules.vue` | 中 | 核心 |
| F15 | 导入及查看本地完整 skill | 已验收 | 读取入口、references 和 assets | `server/rule-files.ts`、`web/src/components/rules/ProjectRules.vue` | 中 | 核心 |
| F16 | 资料指纹、冻结和历史快照 | 已验收 | 固定版本并保留历史内容 | `server/rules.ts`、`server/rule-files.ts` | 高 | 核心 |
| F17 | 工作流绑定固定规则版本 | 已实现并通过 5 项单测及 9 项真实数据库/HTTP检查 | 保证单题始终使用同一套本期规则 | `server/rule-loading.ts`、`server/app.ts`、`workflows.rule_version_id` | 高 | 核心 |
| F18 | 根据基础模板生成项目 skill | 未实现 | 按新一期规则生成独立 skill | 项目规则模板已有，生成执行器待建 | 高 | 核心 |
| F19 | 规则冲突及适用性判定 | 部分：本地 AI 限制已按用户决定覆盖；外部提交资格仍未核实 | 区分本地执行规则与外部提交政策 | `projects/豆包高经济价值-第五期/project.json`、`server/rules.ts` | 中 | 核心 |

### PDF、提取与脱敏

| ID | 功能 | 状态 | 作用 | 关联模块 | 难度 | 核心程度 |
|---|---|---|---|---|---|---|
| F20 | 判断文本型、扫描型和混合型 PDF | 部分 | 选择文本抽取或 OCR | `server/materials/pdf.ts` | 中 | 核心 |
| F21 | 智谱扫描页识别 | 部分：v7 的 66 页 OCR 完成；v8 OCR缓存全部复用，但最终残留检查失败 | 把扫描页转成文字 | `server/materials/vision.ts`、`server/materials/pdf.ts` | 高 | 核心 |
| F22 | JSON 提示词及配置快照 | 已验收 | 固定每次识别任务的参数 | `config/extraction.json`、`server/materials/jobs.ts` | 低 | 核心 |
| F23 | 敏感信息脱敏 | 部分：局部验证通过，整卷阻断 | 形成可供下游使用的材料文本 | `server/materials/vision.ts`、`server/materials/redact.ts` | 高 | 核心 |
| F24 | 同一主体统一替换 | 部分：相同原文一致，别名及主体关联未证明 | 保留身份关联并统一遮盖 | `server/materials/redact.ts`、`server/materials/vision.ts` | 高 | 核心 |
| F25 | 简洁 Markdown 与出处索引 | 部分：第一页已验收 | 降低输入冗余并保留页级出处 | `server/materials/process.ts`、`server/materials/pdf.ts` | 中 | 核心 |
| F26 | 实体核验、有限补充脱敏及失败阻断 | 部分：安全诊断及有限纠正重试已实现，整卷未通过 | 阻止未经检查的内容进入出题 | `server/materials/process.ts`、`server/materials/vision.ts` | 高 | 核心 |
| F27 | 已识别内容的失败后复用 | 部分：只按 OCR 相关配置复用，数据库及受控材料验收通过 | 实体检查失败后不重复 OCR | `server/materials/process.ts`、`server/materials/jobs.ts` | 中 | 核心 |
| F28 | OCR 逐页断点续跑 | 已实现并通过中断/配置变化单测；真实中断续跑待验收 | OCR 中途失败后从已完成页继续 | `server/materials/pdf.ts`、`server/materials/process.ts` | 中 | 支撑 |
| F29 | 私有脱敏映射及缓存访问控制 | 已验收 | 避免公开下载映射或未检查文本 | `server/app.ts`、`server/materials/process.ts` | 中 | 核心 |
| F30 | 脱敏材料可作答性检查 | 未实现 | 确认必要事实、金额和主体关系仍可用 | 第四步质检执行器待接 | 高 | 核心 |

### 队列、调度与模型

| ID | 功能 | 状态 | 作用 | 关联模块 | 难度 | 核心程度 |
|---|---|---|---|---|---|---|
| F31 | 持久化队列及领取去重 | 已验收前两步 | 防止重复执行及重复发布 | `server/intake-jobs.ts`、`server/materials/jobs.ts` | 高 | 核心 |
| F32 | 异步执行与同步等待同一任务 | 已验收前两步 | 支持立即返回或有限等待 | `server/attempts.ts`、`server/app.ts` | 中 | 核心 |
| F33 | 批量执行指定步骤 | 已验收第 1、2、3 步（第 3 步即时完成） | 对最多 100 条题目按就绪状态入队 | `server/app.ts`、`web/src/views/ProjectDetail.vue` | 中 | 核心 |
| F34 | 单题横向自动跑完整流程 | 未实现 | 从当前就绪步骤自动推进到成果 | 全局调度器待建 | 高 | 核心 |
| F35 | 批次纵向阶段推进 | 未实现 | 等待本批当前步骤结束后推进成功子集 | 批次调度器待建 | 高 | 核心 |
| F36 | 心跳、失联判断及恢复 | 部分：前两步有心跳及过期失败标记 | 追踪执行进展并提供重试基础 | `server/intake-jobs.ts`、`server/materials/jobs.ts` | 高 | 核心 |
| F37 | 暂停、取消和恢复控制 | 未实现通用流程 | 停止派发并处理在途尝试 | 调度接口及 worker 待扩展 | 高 | 核心 |
| F38 | 全局并发设置 | 部分：材料两路、Qwen 四路；通用并发配置待建 | 控制 agent、材料和 API 调用并发 | `server/worker.ts`、`server/worker-pool.ts` | 中 | 核心 |
| F39 | Codex 套餐认证和执行 | 已验收底层客户端及真实 ChatGPT 套餐调用；业务步骤待接 | 承载 skill 生成、出题、质检及评分 | `server/codex/client.ts` | 高 | 核心 |
| F40 | Codex 事件、超时、取消及产物校验 | 已实现；12 项单测及真实结构化返回通过 | 区分真实完成、失败和无效产物 | `server/codex/client.ts`、`server/codex/client.test.ts` | 高 | 核心 |
| F41 | 执行角色间的文件隔离 | 部分：7 项本地沙箱检查及真实自身输入读取通过 | 限制不同角色读取和写入的范围 | `scripts/verify-codex-isolation.ts`、Codex 执行器待接 | 高 | 核心 |
| F42 | 国内模型配置和项目选择 | 部分：Qwen/Kimi/DeepSeek/豆包分发及单一 provider 配置已接线；通用模型表及多模型选择待建 | 按项目配置 Qwen、Kimi、DeepSeek、豆包等 | `server/project-folders.ts`、`StepSettings.vue`；通用模型表待建 | 中 | 核心 |
| F43 | 国内模型实际作答及结果留存 | 部分：Qwen 队列及答案留存已接入；真实调用被 OpenRouter 管理 key 的 401 阻断 | 保存原始答案、产物、用量与请求结果 | `server/answer-models/qwen.ts`、`jobs.ts`、`worker.ts` | 高 | 核心 |
| F44 | 认证失效及额度不足后暂停恢复 | 未实现 | 保存断点并等待条件恢复 | Codex/provider 队列待建 | 高 | 核心 |

### 出题、评测、返修及成果

| ID | 功能 | 状态 | 作用 | 关联模块 | 难度 | 核心程度 |
|---|---|---|---|---|---|---|
| F45 | 生成题面、rubric 和完整标答 | 未实现 | 产出可测评的题目包 | 第四步 Codex 任务待建 | 高 | 核心 |
| F46 | 独立质检及交付完整性检查 | 未实现 | 检查事实依据、可作答性及交付项 | 独立质检任务待建 | 高 | 核心 |
| F47 | 构建仅含题面与脱敏附件的作答输入 | 已实现输入白名单并通过单测；端到端作答未通过 | 限制答案、目标分数及私密材料泄漏 | `server/answer-models/input.ts`、`jobs.ts` | 高 | 核心 |
| F48 | 匿名独立逐项评分 | 未实现 | 结合题目、rubric、附件与实际答案判分 | 第六步模型及程序校验待建 | 高 | 核心 |
| F49 | 评分证据、总分和题目版本校验 | 部分：程序校验及持久上下文 API 已实现；独立评分执行/留存待接 | 保证评分有据且绑定正确版本 | `server/scoring/validate.ts`、`context.ts` | 高 | 核心 |
| F50 | 按本期标准判定达标 | 未实现 | 决定发布、返修或隔离 | 第七步判定模块待建 | 高 | 核心 |
| F51 | 有限轮次自动返修及隔离 | 未实现 | 修订未达标题目，限制循环次数 | 返修调度、修订表待建 | 高 | 核心 |
| F52 | 返修原因、成绩变化、时间及费用统计 | 未实现 | 追踪每轮返修过程及改善 | 修订记录、评分和用量汇总待建 | 中 | 核心 |
| F53 | 真实运行时长及步骤证据 | 部分：Codex 事件及实际耗时已记录；项目执行要求待验收 | 验证规则规定的实际执行要求 | `server/codex/client.ts`；业务证据汇总待建 | 高 | 核心 |
| F54 | 合格成果入库及项目输出 | 未实现 | 保存题目、评测记录和产物索引 | 第八步、项目 `outputs/` 待接 | 中 | 核心 |
| F55 | 按项目或批次导出 Excel | 未实现 | 从数据库生成交付表格 | 导出模块待建 | 中 | 支撑 |
| F56 | 导出失败独立重试 | 未实现 | 避免导出失败重新执行题目流程 | 导出任务待建 | 低 | 支撑 |
| F57 | 健康及进展监控 | 部分：有 API 健康检查和任务心跳 | 查看服务、运行状态及进展信号 | `server/app.ts`、worker；监控页面待建 | 中 | 核心 |
| F58 | agent/子进程内存及系统资源监控 | 未实现 | 观察运行资源并控制新任务派发 | worker 及运行监控待建 | 中 | 支撑 |
| F59 | 题量、合格率、耗时及 API 费用统计 | 未实现 | 衡量每周 100 题的实际产能与费用 | 统计查询和后台页面待建 | 中 | 支撑 |
| F60 | UnoCSS 数值尺寸与间距统一 px | 已验收：数字长度直接按 px | 使 `w-44` 等数字尺寸直译为 px | `web/src/theme.ts`、`web/uno.config.ts`、Vue 页面 | 中 | 体验 |
| F61 | 控件尺寸和整体布局验收 | 已验收当前桌面控件：logo 44px、按钮及输入 36px | 保持按钮、输入及页面间距一致 | `web/src/styles/vuetify.css`、`web/src/` 页面 | 中 | 体验 |

## 已有验收证据及范围

本次最新运行：`bun test server` 459 通过、0 失败、1074 次断言；`bun run build`、`bun run check` 均退出 0。

| 记录 | 结果 | 证据边界 |
|---|---|---|
| 第一阶段 | 数据库、项目、上传、历史及浏览器验收通过 | 只证明初始管理和接收能力，不能代表后续步骤 |
| 输入版本 | 真实 PostgreSQL 临时 schema 的 15 项验证通过 | 受控/合成处理结果，不证明真实 OCR |
| 项目目录工作台 | 真实 PostgreSQL 临时 schema 的 17 项验证通过 | 合成 PDF，不调用模型 |
| 规则资料及冻结 | 真实数据库及文件系统的 25 项验证通过；已有 100 项后端测试通过记录 | 证明登记、快照及文件边界，不证明 skill 生成或规则语义正确 |
| Codex 沙箱隔离 | 本机 CLI 的 7 项本地检查通过 | 不证明原生 agent 的全部负向访问场景 |
| Codex 客户端 | 12 项单测；真实 ChatGPT 登录调用通过，21.139 秒 | 只证明执行器，业务步骤尚未连接 |
| UnoCSS/控件 | 构建及类型检查通过；实际浏览器 44px/36px/36px | 当前桌面页面，未做全部设备验收 |
| Qwen 作答 | 队列与输入白名单单测通过；真实请求返回 401 | 当前配置为管理 key，须换普通推理 key |
| 指定 PDF 首页 | 智谱实际识别及脱敏检查通过 | 不能外推到整份 PDF |
| 指定 PDF 整卷 v7 / v8 | v7 66 页 OCR 完成，第 18 页单字实体被阻断；v8 最终残留检查失败 | 未发布可用于出题的脱敏 Markdown；整卷验收失败 |
| 当前健康接口 | API 返回 200，数据库为 connected；项目列表返回首期项目和 0 条工作流 | 只证明当前 API 可连接数据库，worker 存活另外由进程检查确认；主库无任务 |

## 证据来源

- [完整实施计划](../plans/2026-10-07-workflow-mvp.md)
- [整份 PDF 最新失败结果](../evidence/full-pdf-integration-results.json)
- [PDF 识别及同步等待验收说明](../evidence/pdf-and-wait-verification.md)
- [本地规则版本验收](../evidence/rule-workspace-verification.md)
- [项目文件夹与步骤工作台验收](../evidence/project-folder-workbench.md)
- [输入版本验收](../evidence/material-input-versions.md)
- [第一阶段验收](../evidence/phase-one.md)
- [Codex 隔离前置检查](../evidence/codex-isolation-results.json)
- [首期规则冻结记录](../evidence/first-project-rule-freeze.json)

本台账区分了已实现、局部验证和端到端验收。首期本地 AI 出题/脱敏禁令已由用户覆盖，不再阻止内部工作流；外部平台资格仍为 `unverified`。整卷 PDF 的实体检查失败；出题、评分、返修和成果导出尚未实现；Qwen 作答底层已接入，但真实凭证失败，未证明作答闭环完成。

补充证据：[Codex 真实调用](../evidence/codex-client-results.json)、[数字 px 验收](../evidence/unocss-px-results.json)、[源码恢复归档](../evidence/source-baseline.json)、[OCR 根因与调用记录](../evidence/2026-10-08-ocr-diagnosis.md)。

第三步补充：[固定规则加载验收](../evidence/2026-10-08-rule-loading.md)。v8 失败页复验：[第 18 页缓存检查](../evidence/entity-page18-v8.json)。

新测试及清理入口：[题目1与题目3真实测试](../evidence/2026-10-08-real-question-folders.md)。每道题可独立清理生成数据，保留原始PDF；运行中拒绝清理。
