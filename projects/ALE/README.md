<!-- 文件职责：说明 ALE 主项目的共享规则资料、跨领域出题 Skill、七步交付流水线与目录边界。 -->
# ALE

本目录是 **ALE（专业工作任务包、可复现环境、可执行评分与真实运行轨迹）** 主项目根目录。设计组织对齐 `projects/豆包高经济价值` 与 `projects/Work法律全场景`，支持跨期共用 `materials/`、`skill/` 与 `scripts/`。

开始处理本项目前，请先阅读 [`AGENTS.md`](AGENTS.md) 了解六道验收状态边界与隔离红线。

## 项目核心指标速览（依据《ALE 数据交付技术规范 · 需求沟通v1》）

| 维度 | 规范硬指标 |
| --- | --- |
| **领域与净量需求** | 按去重且验收合格的独立任务计净量：`computing_math` 200、`life_science` 200、`health_medicine` 200、`business_finance` 200、`engineering` 200、`visual_media` 200、`physical_science` 100；其他 `domain` 每个最多 50 条；各 `domain` 内 `sub_domain` 均匀分布 |
| **去重与原创净量** | 合法复用软件环境不扣题数；但**只换名称、数字或种子的同构题不重复计数**；公开原题、直接改写和历史重复交付不计新增原创净量（须披露上游与增量） |
| **环境与原生产物** | 默认离线可复现（容器固定 digest 或 Windows/GUI VM 快照＋`reset.sh`）；Agent 严禁可见 `reference/solution/rubric`；CAD、Blender/音视频、XLSX/Office、Web/应用、科学计算须执行原生产物实质检查（截图/导出件不替代原生工程） |
| **评分与成功门控** | 每条 `criterion` 具备题面依据、材料位置、观察位置、判断条件、权重、容差、关键门控（`is_key_gate`）；确定性参考得满分 `1.00`，连续专业评审参考 `≥ 0.90` 且关键项全过；二值 `success` 要求达合格线且全部关键项通过 |
| **难度标定与轨迹** | 最终版本用 `GPT-6.1-Sol` 或 `Opus-5.5`（`reasoning_effort = max`）独立跑满 8 次，**仅保留成功 1–3 次（12.5% / 25% / 37.5%）**；另交 ≥1 条 `opus-5` 或 `gpt-5.6-sol` 真实完整成功轨迹；全量成功轨迹经防 hack 审核与专属 `canary` 保护 |
| **全量动态质检** | 逐题验证参考基线、`no-op = 0`、骨架/常量伪造 `≤ 0.20` 且不成功、9 类单因子错误反例精准失分、合法等价解不误罚；最小记录含 `check_id` 等 9 字段 |
| **标准交付格式** | `batch/`：`batch_manifest.json` + `SHA256SUMS.txt` + `trajectory_stats.csv` + `tasks/<task_id>/` + `shared/{materials,environments}/`，UTF-8 编码，拒收 LFS 指针与占位文件 |

## 目录结构与文件索引

```text
ALE/
├── AGENTS.md                                      # AI 协作规则与六道状态边界
├── README.md                                      # 主项目总览与导航（本文件）
├── materials/                                     # 跨期共用项目方权威规范（参与规则指纹，不放临时文件）
│   └── ALE数据交付技术规范.md                      # 需求沟通v1（2026-10-19）4页PDF 100%逐字转化稿
├── skill/                                         # 跨领域高强度任务设计与打包 Skill（参与任务指纹，不加目录README）
│   ├── SKILL.md                                   # 作者总控入口：八大铁律、1–3/8黄金难度引擎、五阶段按需路由与八条红线
│   ├── references/
│   │   ├── 00-材料筛选与深层线索整理.md            # ALE材料闭环准入、表层vs深层双层结构与2–3处公平破局锚点设计
│   │   ├── 01-领域规划与防同构立意.md              # 7+领域配额、sub_domain均衡、“同核异形”防换皮核减与Canary设计
│   │   ├── 02-高负荷任务设计与黄金难度校准.md      # 完整工作日倒推、四层输入穿透、五类跨领域加压与12.5%–37.5%校准器
│   │   ├── 03-环境隔离与原生产物验证.md            # 容器/VM可复现构建、五阶段隔离、五大类原生产物实质检查与故障显式报错
│   │   ├── 04-可执行评分与单因子反例测试.md        # rubric.json七要素、is_key_gate、grade.py实态断言与9类单因子反例≤0.20门控
│   │   └── 05-轨迹完整性防Hack与题包契约.md        # 第7节目录契约、8次标定+opus-5/gpt-5.6-sol轨迹、Token/轮次复算与防hack审计
│   ├── domains/
│   │   └── life_science/                              # 生物科学垂类专属规则与场景模块（按 domain 定点加载）
│   │       ├── guide.md                               # life_science 材料准入、紧凑汇总底稿红线与跨条款概念耦合校准总控
│   │       └── scenarios.md                           # life_science 6大子方向32项科研工作流与8类实验数据冲突速查矩阵
│   └── assets/
│       ├── ale_grader_lib.py                          # 出题沙盒内可直接导入自检的标准公共判分底座库（与 scripts/ 同源）
│       ├── 跨领域高价值场景与原生产物核查库.md      # 7大核心domain+综合领域共36个sub_domain实务工作流、脏数据形态与反捷径检查库
│       ├── 任务包与契约模版.md                     # task_card.json / instruction.md / env.json / rubric.json / grade.py / run.json / review 模版
│       └── 专业交办表达与防同构组件库.md           # 跨领域自然办公交办结构、去模拟/去黑话对照与“同核异形”变体矩阵
├── custom-steps/                                  # 仅对 ALE 生效的工作台隔离定制步骤（不影响其他项目）
│   ├── README.md                                  # 定制步骤职责、锚点与灵活标定档位说明
│   ├── index.ts                                   # ALE 定制步骤导出与注册入口
│   ├── pre-authoring-lock.ts                      # 出题前输入文件名与 SHA-256 映射锁定（0 槽位）
│   ├── verify-gate.ts                             # 出题后反例硬筛与 Rubric 防误杀门控平衡检查
│   └── calibrate-8plus1.ts                        # 支持 3/5/8+1 灵活档位与早停撤单的单槽位子运行标定器
├── scripts/                                       # 项目质检、单题归档与第7节批次组包工具链
│   ├── README.md                                  # 七步完整交付SOP与CLI使用说明
│   ├── ale_grader_lib.py                          # 标准公共判分底座库（随每题自动打入私有 tests/ale_grader_lib.py）
│   ├── office_lint.py                             # 零业务知识通用格式/公式重算回显工具（自动打入公开 environment/tools/）
│   ├── archive.ts                                 # 工作台第8步归档准备入口：装填已核验冻结输入附件
│   ├── contracts.ts                               # 第1–7节公共Schema、配额、分位数/Token复算与校验原语
│   ├── verify-task.ts                             # 单题全量质检与单因子反例核验CLI（输出第6节标准 check_id 记录）
│   ├── calibrate.ts                               # 本地 Codex CLI 隔离作答、8次标定与自动评分运行器
│   ├── batch-package.ts                           # 第7节 batch/ 标准组包、去重净量统计、trajectory_stats.csv 与 SHA256SUMS 生成器
│   └── delivery.ts                                # 对接 ai-distill 第8步归档入口：导出单题 tasks/<task_id>/ 预备包并生成诚实核验报告
└── 执行观察/                                       # Trace 执行追溯记录（非任务输入，不进入扫描）
```

## 维护边界

- `materials/` 保存买方规范原文；注意为保证规则指纹纯粹，`materials/` 下直接存放规范文件，来源说明登记在本表（2026-10-19 需求沟通 v1 四页 PDF 100% 原文转换）。
- `skill/` 下的全部文件作为作者上下文参与任务指纹计算，不在 `skill/` 内放置目录 `README.md`、测试日志或历史草稿。
- 本地脚本生成预备包或批次 ZIP 成功，仅证明当前已执行的静态/动态检查通过，不替代未运行的容器/VM 实测、真实模型 8 次标定或买方书面哈希冻结接收。
