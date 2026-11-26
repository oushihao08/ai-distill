# Work 法律全场景：AI 工作事实与项目规则

本文件汇总钉钉官方最新规则（截至 2026-11-17 核验）与本地代码已实现的流程边界。项目状态、题目数量、尝试结果须查当前工作台 API，不能从旧记录或本文件推断。

## 一、规则与结构分别看哪里

- **Agent 出题入口与方法**：统一从 [`skill/SKILL.md`](skill/SKILL.md) 进入，按四阶段导航读取：
  - 立场、六类执业主体、首批 `L2–L5 ↔ LS02–LS05` 映射、长程分级与存量避重：[`skill/references/01-场景立场与首批LS规则.md`](skill/references/01-场景立场与首批LS规则.md)、[`skill/assets/法律垂类场景与实务核查库.md`](skill/assets/法律垂类场景与实务核查库.md)；
  - 穿透读卷、难度加压（三 SOTA 模型均分 ≤55%）与完整求解核验：[`skill/references/02-高强度实务设计与求解方法.md`](skill/references/02-高强度实务设计与求解方法.md)；
  - Rubric 设计（≥30 项、六档加减分、F1–F5 双锚点 ≥30%、无 Veto/无正话反说、`golden` 回测 >0.90）：[`skill/references/03-Work评分方案与加压验题.md`](skill/references/03-Work评分方案与加压验题.md)；
  - `work_legal_v1` 字段契约、必交 `法规案例检索轨迹.xlsx`、真实委托双口吻与退回红线终检：[`skill/references/04-五件套契约与交付规范.md`](skill/references/04-五件套契约与交付规范.md)、[`skill/references/05-饱满去模板与防剧透表达.md`](skill/references/05-饱满去模板与防剧透表达.md)、[`skill/assets/书面表达与交办组件库.md`](skill/assets/书面表达与交办组件库.md)、[`skill/assets/题目信息填写示例.md`](skill/assets/题目信息填写示例.md)、[`skill/assets/检索轨迹填写示例.tsv`](skill/assets/检索轨迹填写示例.tsv)。
  - 注：`skill-c/` 为重构前的旧平铺原版备份，不作为工作台默认读取入口；历史 `materials/` 转录不是当前必读入口。若分期项目工作区下存在 `<期次>/skill/SKILL.md`，系统按 `server/rule-files.ts` 优先读取期次覆盖目录，派发前须核对实际生效路径。
- **代码字段结构**：出题步骤配置选择 `work_legal_v1`，评分步骤配置选择 `model_report_v1`。实际 Schema 与准入校验见 [`server/lifecycle/projects/work-contract.ts`](../../server/lifecycle/projects/work-contract.ts) 与 [`server/lifecycle/projects/work.ts`](../../server/lifecycle/projects/work.ts)（`server/authoring/work-contract.ts` 为旧导入兼容）。Skill 负责指导内容与专业难度设计，不擅自扩展程序字段。

## 二、钉钉官方最新核心规则（2026-11-17 / 10-28 核验）

以下提炼自钉钉《Work法律全场景评测数据集构建规则》（11-17 修订）、《Work法律全场景评测Rubrics设计要求》（11-17 修订）及《Work法律全场景评测题包交付规范》（10-28 修订）：

1. **数据集定位、分布与去重铁律**
   - 全集共 **150 题**（第一批 60 题、第二批 90 题），覆盖诉讼律师（9 个三级场景/35 题）、非诉律师（11 个/30 题）、企业法务与合规（14 个/45 题）、法官与法院辅助（7 个/17 题）、检察官与检察辅助（6 个/14 题）、立法与政策研究（4 个/9 题）共 **6 类执业主体、24 个二级分类、51 个三级场景**。每个三级场景不少于 2 题，同场景题目须覆盖不同案由、合同类型或业务。
   - **长程等级分布**：`L2 : L3 : L4 : L5 = 50 : 50 : 30 : 20`，**L1 不采用**。L4/L5 共 50 题限定在配额 ≥3 题的 **22 个场景**内（`LS01, LS02, LS04, LS05, LS07, LS08, TL01, TL04, TL05, IC01, IC02, IC04, IC05, IC07, IC08, IC09, IC10, IC11, JG03, JG05, PG02, PR03`）；配额 2 题的 29 个场景以 L2/L3 为主且两题分属不同等级。
   - **严禁重复与存量撞车**：全部须为新提交题目及数据包，严禁复用或迁移 `Work360-法律领域项目`、`Work0-1项目`、`C项目` 已交题目，且新题须避开《构建规则》附表 1.4 所列 Work360 存量已覆盖的具体案由/合同类型/业务方向（详见 `skill/references/01-场景立场与首批LS规则.md`），重复提交不予结算。
   - **真实付费工作原则**：任务必须是真实实务中“有人会为此付费”的工作，不接受纯粹为测 LLM 弱点设计的 adversarial 题，不接受用冗余步骤、额外工具或单页摘录凑份数抬高定级。

2. **官方验收双硬门槛**
   - **内容准确性与 `golden` 预检**：任务描述、源文件、标准交付物、评分方案内容准确性均需 **≥ 99%**；按评分细则对标准交付物（`golden_output`）打分，**得分率须 ≥ 90%**（Harbor `solve.sh` 预检要求 `> 0.90`，须满足全部正分项且不触发任何负分扣分项，不达标整题退回）。
   - **SOTA 难度门槛**：在 Claude Code 框架下，从 `Claude opus5`、`GLM5.3`、`Kimi-K3`、`Qwen3.8-max0902` 中选 **3 个待测模型**（注：官方主文写裁判模型为 `GPT-5.6 Terra`，附录一处写 `Gemini 3.8 flash`，Harbor 模板默认 `GPT-5.6 Terra`），**所有层级题目的三模型均分均须不超过 55%**（`< 0.55`），且至少有 1 个模型得分。

3. **任务包五部分核心规范与 11-17 通报退回红线**
   - **任务描述（`instruction.json` / `instruction.md`）**：含业务/案件背景、委托方诉求、交付物要求、基准时间点、硬约束（独立编号单列）五要素。
     - **口吻要求**：普通委托人以第一人称口述为主体，混入口语化干扰、啰嗦、顺序颠倒、冗余或矛盾信息，允许并鼓励包含不专业、不可行或越界诉求以检验模型独立纠偏能力，交付物要求停留在委托人能说出口的程度（不写文书体例、不评价证据性质与法律关系）；委托方本身为律师、法务、法官、检察官、监管人员等专业人士时，按对应专业行文撰写，同样严禁提示考点或出现“本题/考察/请注意/重点是”等出题痕迹。
     - **脱敏主体清晰**：禁止把主体涂抹成空白且不在任务说明交代对应关系；须让模型能明确识别或从在卷地位可靠推出委托方与相对方。
   - **源文件（`input_files/`）**：真实实务材料脱敏改写且内容完整（L2≥3 份、L3≥10 份、L4≥50 份、L5≥100 份且多项目跨期）。严禁：时间线倒置（如送达回证早于通知书、前文预知后判、诉后材料充诉前证据）、缺签章或笔录法定要素、编造查无此案的案号、AI 仿真同质表格/复用签名、1–3 页摘录冒充完整卷或 0 字节坏件、混入完全无关凑数文件、金额违背常理或统一社会信用代码校验位错误。
   - **标准交付物（`golden_output/`）**：F1–F5 各任务类型除业务文书外，**`法规案例检索轨迹.xlsx` 为全部任务类型的必交项**（缺检索轨迹直接退回）。
     - 法源引用必须含**规范全称＋中文条次款项（部门规章附令号、司法解释附法释文号、修订年份置书名号外、案例附案号＋裁判要点＋来源）＋条文原文或规定摘要**，不得只写条号，且条文必须与官方原文一致、严禁错引新修条号到旧时点或引用已废止文件。
     - 检索轨迹须覆盖主交付物与 Rubric 的每一条援引，含检索词、命中要点（法条原文或裁判要旨）、一档官方正文 URL 及新旧法版本核验对照；三档来源（公众号、律所推文、百科、问答社区、聚合资讯）严禁作为依据，出现即在 Rubric 扣分。
     - 严禁编造 `input_files` 没有的事实（每项事实须可定位到源件，无依据的写“待核实”），严禁案号代字或法律概念错用（如“民撤”写“民初”、“行政罚款”写“行政处罚金”），严禁内部自相矛盾、残留模板占位符、字数不达标或缺失文书法定首尾结构。
   - **评分方案（`rubric.json` / `rubrics.toml`）**：遵循原子性、客观性、完整性、自包含、鲁棒性五准则；《题包交付规范》6.7 明确其与构建规则不一致时以交付规范维度与权重格式为准：
     - 一级维度 1–7（必设 `1`、`2`、`5`，另从 `3`、`4`、`6` 至少选 2 个，`7` 按需选设反偷懒负向），维度 2 二级维度 `Q1–Q7`（至少选 `Q1–Q6` 中 3 个，必含 F1–F5 对应双锚点且双锚点正分 ≥ 正向满分 **30%**，`Q7` 默认仅设内部矛盾负向）；
     - 权重仅限六档 **`+10 / +7 / +3 / -3 / -7 / -10`**（每题至少 **2 条 `+10`**，`Subjective ≤ 10%`，完整题包 **≥ 30 项**；**不设 `0-一票否决/Veto`、不设 `trigger_count` 累加文本**，确需按违规处数分档时用单条负向 `likert` 5/4/3/2/1 锚点承载）；
     - **严禁八类退回错误**：正话反说（负向重述正向未完成造成双扣）、同一事项/法条/数值拆多条重复计分、要求 `input` 没有的事实、要求 `golden` 没做到的内容、把错误法律观点固化进判据、恶意负分控分、分值悬殊失衡。
   - **题目信息（`metadata.json`）**：与《题目认领登记表》一/二/三级场景完全一致（不简写归并），评测能力 2–4 项，3 年以上从业者实际业务耗时（小时，不含设计题包时间），含扫描件/图片/图表截图时如实标 `vl_dependency: true` 并列明文件，清除一切“待专家确认”临时文字。

## 三、本地工作流与工程边界

### 材料包与题目的数量关系

- 本项目固定实行 **一个材料包只对应一个题目身份**。每个已纳入本项目的材料包只能关联一个题目，包内全部附件共同构成本题来源；不得按附件数、文书数或案件子环节拆成多道题。返修、重出和重评沿用原题身份，不另建第二题。
- 历史数据若存在同一材料包关联多个题目，先核对并报告重复关系，不擅自删除历史，也不再为该包新建题目。此规则仅约束 Work法律全场景，不改变系统对其他项目的通用能力。

### 步骤 1–8 代码数据流与现状限制

1. **材料入库与脱敏（步骤 1 / 9 / 材料库）**：支持脱敏产物或共享材料库已完成提取的原文版本；新题创建时冻结来源模式，旧题沿用自身快照。执行成功不代表提取零遗漏或原件无时间线瑕疵，出题前仍须按官方源文件红线核查正文。
2. **出题（步骤 4）**：在项目工作目录运行，读取冻结附件、当前生效 `skill/`、步骤配置与角色/场景/等级设置，按 `work_legal_v1` Schema 输出完整 JSON（公开 `question`、`reference_answer`、`answer_requirements` 与判据 `criterion/rule` 由程序同源派生）。
3. **被测作答（步骤 5）**：当前本地 `work_legal_v1` 接收层固定回填 `answer_requirements = { input_mode: "text", output_mode: "text", tools: [] }`，走 `text_deliverables_v1` 纯文字分节呈现（不代表已创建实体 Office 文件或联网检索）。因此 Rubric 的核心业务项须聚焦事实梳理、法源原文援引、要件涵摄、计算口径与数值准确及可执行要素，**不得在 `statement` 中要求检验底层 OOXML 公式标签或容器命令**，以免本地文字评分失真或与静态导出的 `golden_output/*.xlsx` 冲突。
4. **独立评分（步骤 6）与达标判断（步骤 7）**：评分器读取同版题面、Rubric、匿名答案、冻结附件及文字呈现约定（校准模式下提供标答仅作结构与量级参考，非唯一答案键），不读取项目 Skill、作答思路或目标分；算术工具按 `clip(净分 / 正向满分, 0, 100)` 核算比较指标。步骤 7 按项目配置的模型集合与阈值（对标官方 ≤55%）机械判定，须看 `decision === "accepted"` 才算达标。
5. **归档与五/六件套生成（步骤 8）**：复核当前版本 `accepted` 与 `assertWorkSubmissionReady`（`content_status: "complete"`、Rubric ≥30 项、成果仅 `.docx`/`.xlsx`、受众纯净无 AI/工具/评分残留、至多 1 份检索轨迹）后调用 [`scripts/delivery.ts`](scripts/delivery.ts)：
   - **Siriser 确认稿五件套**：由 [`scripts/siriser/generate-five-piece.ts`](scripts/siriser/generate-five-piece.ts) 的 `generateSiriserConfirmation()` 生成 `instruction.json`、`metadata.json`、`rubric.json`、`input_files/`、`golden_output/` 及同名 UTF-8 ZIP。注意：**`golden_output/` 仅按冻结 `deliverables` 清单生成文件**（`.xlsx` 单元格仅支持字符串/数字/布尔值并附“正文说明”表，`instruction.json` 当前固定导出 `commissionerType: "professional", tone: "法律专业人士"`），因此作者**必须在 `deliverables` 中显式声明 `法规案例检索轨迹.xlsx`**，否则五件套将缺失必交检索轨迹。
   - **Harbor 单题六件套预备包**：由 [`scripts/harbor/export-accepted-task.ts`](scripts/harbor/export-accepted-task.ts) 在具备外部 `delivery_identity`（`task_id`/`org`）与 `domain_l2` 时生成；脚本会拒绝 `Veto` 项、`trigger_count` 累计文本及超过 100 KB 的 `prompt.md + criteria`。Harbor 未就绪仅记 `pending`，不阻断 Siriser 五件套（官方流程第四步由项目组在质检通过后统一转换 Harbor）。

## 四、防止误判与汇报纪律

- 报进度分开表述：本地步骤执行状态、内容是否按官方规范核验、Siriser 提交回执状态（如“验收中”）、项目方最终验收（Oracle >0.90、三模型均分 ≤55%、专家终审）。严禁用前一项替代后一项。
- 报分先说明评分对象、模型组合与计分口径；运行成功率、本地达标率、Rubric 算术正确率、法律专业准确率分开报告，未核验维度写“未核验”。
- 本地 AI 生成的标准成果与检索记录在内部快照与 `generation_note` 中如实标明 AI 身份，严禁冒称真人律师签署、外部已认领或平台已验收；同时 `reference_outputs` 业务正文保持真实收件人纯净语境，不混入制作说明。

## 五、代码导航

- 生命周期与内容契约：[`server/lifecycle/projects/work.ts`](../../server/lifecycle/projects/work.ts)、[`server/lifecycle/projects/work-contract.ts`](../../server/lifecycle/projects/work-contract.ts)
- 出题队列与执行：[`server/authoring/jobs.ts`](../../server/authoring/jobs.ts)、[`server/authoring/executor.ts`](../../server/authoring/executor.ts)
- 作答输入与文字呈现：[`server/answer-models/input.ts`](../../server/answer-models/input.ts)、[`server/answer-models/dispatch.ts`](../../server/answer-models/dispatch.ts)
- 独立评分与算术复算：[`server/scoring/context.ts`](../../server/scoring/context.ts)、[`server/scoring/executor.ts`](../../server/scoring/executor.ts)、[`server/scoring/arithmetic-tool.ts`](../../server/scoring/arithmetic-tool.ts)
- 归档、Siriser 五件套与 Harbor 六件套：[`server/publishing/jobs.ts`](../../server/publishing/jobs.ts)、[`scripts/delivery.ts`](scripts/delivery.ts)、[`scripts/siriser/generate-five-piece.ts`](scripts/siriser/generate-five-piece.ts)、[`scripts/harbor/export-accepted-task.ts`](scripts/harbor/export-accepted-task.ts)
