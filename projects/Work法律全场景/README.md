# Work法律全场景

AI 开始处理本项目任务前先读 [AGENTS.md](AGENTS.md)，了解钉钉官方最新规则（2026-11-17 / 10-28 核验）、本地代码契约、各步骤输入边界以及本地执行成功与外部平台验收的区别。本文档中的历史数量和快照不代替当前工作台 API 状态。

本目录是 Work 法律全场景项目的主项目资料根。本项目固定实行 **一个材料包只对应一个题目身份**：包内全部附件共同支撑该题，不按附件、文书或案件子环节拆多题；重出、返修和重评沿用同一题目身份，不另建第二题。历史上若有重复关联，先核对并报告，不擅自删除历史。具体执行要求见 [AGENTS.md](AGENTS.md) 与 [出题 Skill](skill/SKILL.md)。

---

## 一、官方规则基准（2026-11-26 登录态全量核验）

| 官方文档 | 钉钉链接 | 文档最后编辑 | 核心职责与上下位关系 |
| --- | --- | --- | --- |
| Work法律全场景评测数据集构建规则 | [钉钉文档](https://alidocs.dingtalk.com/i/nodes/QOG9lyrgJPPNL2rXIlMRAmQAJzN67Mw4) | `11-17` | 顶层总纲：150 题总量与 6 类主体/24 二级/51 三级场景分布、L2–L5 长程分级、五部分交付物内容规范、Work360 存量避重清单、验收双门槛及五大交付物退回常见问题 |
| Work法律全场景评测 Rubrics 设计要求 | [钉钉文档](https://alidocs.dingtalk.com/i/nodes/YndMj49yWjlAYoxjtbB0BXxAJ3pmz5aA) | `11-17` | 评分细则规范：来源于 `golden_output`、五项准则（原子/客观/完整/自包含/鲁棒）、维度 1–6 与 Q1–Q6 编写细则、F1–F5 双锚点 ≥30%、Likert 5 档锚点及分析型元数据字段 |
| Work法律全场景评测题包交付规范 | [钉钉文档](https://alidocs.dingtalk.com/i/nodes/lyQod3RxJKe9QjOMiljdlo20Wkb4Mw9r) | `10-28` | Harbor 六件套与计分器规范（第 6.7 节声明维度与字段格式与构建规则不同时以本规范为准）：六档权重 `+10/+7/+3/-3/-7/-10`（`negate=true`，无 `Veto`）、维度 1–7 与 Q1–Q7、`golden` 预检 `> 0.90`、三模型均分 `< 0.55` |

### 1. 官方验收与分级硬指标速查

- **验收红线**：① 各部分内容准确性 **≥ 99%**；② `golden_output` 按 Rubric 打分得分率 **≥ 90%**（Harbor 预检 `> 0.90`，须命中全部正项且零触发负项）；③ Claude Code 框架下 `Claude opus5`、`GLM5.3`、`Kimi-K3`、`Qwen3.8-max0902` 中三模型均分 **≤ 55%**（且至少一模型得分）；④ 严禁复用 `Work360`、`Work0-1`、`C项目` 历史题目或撞车存量已覆盖方向。
- **长程等级矩阵（L1 不采用）**：
  - **L2**（50 题）：专家人时 `0.5–2h`｜必要步骤 `10–30`｜源文件 `≥ 3 份`（典型 3–5 份）｜工具 `2–3 类`｜必要调用 `10–50`
  - **L3**（50 题）：专家人时 `2–8h`｜必要步骤 `30–100`｜源文件 `≥ 10 份`｜工具 `3–4 类`｜必要调用 `50–200`
  - **L4**（30 题）：专家人时 `8–40h`｜必要步骤 `100–500`｜源文件 `≥ 50 份`｜工具 `4 类`｜必要调用 `200–2000`（限 22 个配额 ≥3 题的场景）
  - **L5**（20 题）：专家人时 `40h+`｜必要步骤 `500+`｜源文件 `≥ 100 份` 且**多项目跨不同时期**｜工具 `4 类`｜必要调用 `1000+`｜交互/状态轮次 `≥ 15`（限高体量跨期场景）
- **两阶段任务包目录对照**：
  - **初稿五件套**：`任务说明.docx`、`题目信息表.docx`、`评分要点.xlsx`、`input_files/`、`golden_output/`
  - **平台确认稿五件套（Siriser 导入/导出及本地 `work_legal_v1` 默认生成）**：`instruction.json`、`metadata.json`、`rubric.json`、`input_files/`、`golden_output/`（含逐份业务文书及必交 `法规案例检索轨迹.xlsx`），总目录命名 `法律-{三级场景编号}-{提交日期}-{专家姓名}`，返修件后缀 `-v2` 并附 `返修说明.docx`。
  - **Harbor 六件套（第四步质检通过后转换）**：`LAW-序号/` 下含 `instruction.md`、`task.toml`、`rubrics.json`、`environment/`、`solution/`、`tests/`。

---

## 二、当前目录与文件说明

### 1. 出题 Skill 目录（`skill/`，当前生效入口）

全部文件参与出题任务指纹，目录内不放额外 README：

| 路径 | 用途与边界 |
| --- | --- |
| [`skill/SKILL.md`](skill/SKILL.md) | Work 法律全场景出题总控入口：铁律、六大合规压难机制、四阶段读取路由与保存前硬红线 |
| [`skill/references/01-场景立场与首批LS规则.md`](skill/references/01-场景立场与首批LS规则.md) | 一包一题、6 类执业主体与单方/中立立场、51 三级场景分布、首批 `L2–L5 ↔ LS02–LS05` 映射、L2–L5 分级清点及 Work360 存量避重表 |
| [`skill/references/02-高强度实务设计与求解方法.md`](skill/references/02-高强度实务设计与求解方法.md) | 穿透读卷四区分、边缘凭证消歧、不合理诉求识别纠偏、跨时际法源原文核验、多约束动态复算与“三模型均分 ≤55%”实务加压方法 |
| [`skill/references/03-Work评分方案与加压验题.md`](skill/references/03-Work评分方案与加压验题.md) | 对齐 11-17 & 10-28 规范的 ≥30 项六档加减分 Rubric（无 `Veto`、无累计字符串、禁正话反说）、14 项维度与 36 项原子能力枚举、双锚点 ≥30%、`golden >0.90` 与对抗答卷试判 |
| [`skill/references/04-五件套契约与交付规范.md`](skill/references/04-五件套契约与交付规范.md) | `work_legal_v1` 字段规范、F1–F5 必交 `法规案例检索轨迹.xlsx`＋≥3 份业务成果、一档法源原文格式、受众纯净拦截与 11-17 退回红线对照 |
| [`skill/references/05-饱满去模板与防剧透表达.md`](skill/references/05-饱满去模板与防剧透表达.md) | 官方双口吻还原（普通委托人口语干扰与越界诉求 / 专业交办）、脱敏主体清晰交代、防剧透五禁令与去模板终检 |
| [`skill/assets/法律垂类场景与实务核查库.md`](skill/assets/法律垂类场景与实务核查库.md) | 62 项法律实务细分方向与高负荷实质工作索引（按本包材料领域定点查阅，不作硬套模板） |
| [`skill/assets/书面表达与交办组件库.md`](skill/assets/书面表达与交办组件库.md) | 同核异形选题、双口吻交办切入、自包含判据写法与自然任务命名示范 |
| [`skill/assets/题目信息填写示例.md`](skill/assets/题目信息填写示例.md) | 题目信息表栏目组织示例（仅参考形式，不继承案件事实、分值或等级） |
| [`skill/assets/检索轨迹填写示例.tsv`](skill/assets/检索轨迹填写示例.tsv) | 检索轨迹表栏目填写示例（仅参考形式，不替代本次真实联网核验） |

> `skill-c/` 保留重构前的平铺 6 文件原版作为只读对照备份，工作台默认不加载 `skill-c/`。

### 2. 项目脚本与辅助资料

| 路径 | 用途 | 来源与边界 |
| --- | --- | --- |
| [`AGENTS.md`](AGENTS.md) | 本项目 AI 协作事实、官方规则摘要与本地代码契约边界 | 每次执行或修改本项目任务前先读 |
| [`material-prep/SKILL.md`](material-prep/SKILL.md) | 材料准备候选处理提示词与接入设计 | 与出题 `skill/` 独立；期次实际材料处理模式由数据库步骤 4 `material_processing_mode` 控制 |
| [`scripts/README.md`](scripts/README.md) | Work 项目脚本总索引 | 归档入口、Siriser 五件套、Harbor 六件套工具分组说明 |
| [`scripts/delivery.ts`](scripts/delivery.ts) | 达标题目归档交付入口 | 校验 `accepted` 快照，生成 Siriser 确认稿五件套 ZIP、尝试 Harbor 单题六件套预备包并保存私有快照 |
| [`scripts/siriser/generate-five-piece.ts`](scripts/siriser/generate-five-piece.ts) | Siriser 五件套生成器（含 `generateSiriserConfirmation` 与旧初稿兼容） | `work_legal_v1` 按冻结 `deliverables` 渲染 `.docx`/`.xlsx`；作者须在 `deliverables` 声明检索轨迹 `.xlsx` |
| [`scripts/harbor/export-accepted-task.ts`](scripts/harbor/export-accepted-task.ts) | Harbor 单题六件套导出器 | 校验 `LAW-序号`、`org`、六档权重与固定脚本摘要；拒绝 `Veto` 与模糊累计扣分 |
| [`scripts/harbor/batch-package.ts`](scripts/harbor/batch-package.ts) | Harbor 批次目录与 ZIP 显式组包器 | 消费单题目录与批次 manifest；缺必交内容失败关闭 |
| [`scripts/harbor/official/tests/`](scripts/harbor/official/tests/README.md) | 官方页面附录 A.1/A.2 固定脚本副本（`test.sh`、`finalize.py`） | 与钉钉规范代码块 SHA-256 一致；不代表已完成容器构建或 Oracle 跑测 |
| [`Siriser提交路径与五六件套核验.md`](Siriser提交路径与五六件套核验.md) | 2026-10-16 平台导入试验、五/六件套职责与三级场景核验记录 | 历史实测证据，具体配额与任务状态以当前网页和 API 为准 |
| [`网页操作说明-题包上传与提交.md`](网页操作说明-题包上传与提交.md) | Siriser 市场领取、任务页上传 ZIP、质检 Agent 处理与提交回读操作说明 | 页面状态以操作当日核对为准；“验收中”不等于“验收通过” |

---

## 三、目录与运行边界说明

- **本地文字链路与外部评测的区别**：当前本地步骤 5 作答器以受控纯文字分节呈现（`text_deliverables_v1`），步骤 6 独立评分按冻结 `model_report_v1` 契约隔离评判；外部官方验收在 Claude Code 容器内读写 `/app/input_files/` 与 `/app/output/` 二进制交付物并执行 Harbor `solve.sh` + `test.sh`。因此出题既要保证 `reference_outputs` 能渲染出完整可用的真实 `.docx`/`.xlsx`（使 `golden` 预检 `> 0.90`），又要让 Rubric 的核心区分度建立在真实的事实穿透、法源核验、要件涵摄与精确计算上，而非绑定本地未验证的底层 OOXML 公式属性。
- **材料处理入口**：期次材料处理由 PostgreSQL 步骤 4 配置字段 `material_processing_mode` 控制（默认 `aliases` 整包化名，可选 `original` 已提取原文）；新题创建时冻结模式与材料快照，旧题不随期次设置变更切换来源。详见 [`server/material-library/README.md`](../../server/material-library/README.md)。
- **历史阶段记录保留说明**：2026-10-13 至 2026-10-17 期间关于首批筹备本地材料包登记、模型工作流配置、五件套 CLI 下载与 Siriser 提交试运行的历史背景见 [`Siriser提交路径与五六件套核验.md`](Siriser提交路径与五六件套核验.md) 与 [`网页操作说明-题包上传与提交.md`](网页操作说明-题包上传与提交.md)；当前有效题目清单、尝试状态与达标结果一律通过本机工作台 HTTP API 实时查询。
