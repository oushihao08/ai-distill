# Work法律全场景评测题包交付规范（页面正文转录）

- 来源：钉钉文档 <https://alidocs.dingtalk.com/i/nodes/lyQod3RxJKe9QjOMiljdlo20Wkb4Mw9r>
- 页面显示作者：陈晓丽；创建时间：09-13 19:58；页面显示最近编辑：10-13。
- 转录说明：钉钉“下载到本地”控件对该 Wiki 文档禁用，以下是登录态页面可见正文的滚动分段转录，保留正文措辞，移除复制按钮、行号等页面控件；表格和代码块按页面文本顺序整理。附录 A 的 `tests/test.sh`、`tests/finalize.py` 已按页面代码块完整转录。附录 B 的 Skill 示例正文在原页面中本身就是省略说明，没有可转录的 SOP 正文；此处保留原页面的省略标记，不自行补写。它不是钉钉原生 DOCX/PDF 导出，核对版式或页面更新时请回到原链接。

---

## 正文

说明：
●
本交付规范文件为
Work法律全场景评测数据集构建规则
附件，供应商交付的数据需同时符合
Work法律全场景评测数据集构建规则
及本规范要求。
●
本文档规定题包格式与评分器写法；题包内具体各交付物的内容质量与法律专业要求（题面口吻、源文件真实性、golden 写作、rubric 设计、法条案例引用格式、检索轨迹等）一律以
Work法律全场景评测数据集构建规则
文档内要求为准。
●
本文档涉及固定模板内容的（详见附录A），供应商需逐字复制，不得改动。
1. 速览
1.1 一题一目录，六件套
目录名 = 题目编号
LAW-001/                         # 目录名 = 题目编号
├── instruction.md                   # 任务描述（仅接受此文件名）
├── task.toml                        # 配置 + 元数据
├── rubrics.json                     # 原始评分细则
├── environment/                     # 执行环境（构建上下文 = 本目录）
│   ├── Dockerfile                   #   单文件含全部依赖
│   ├── requirements.txt             #   无依赖交空文件
│   └── input_files/                 #   源文件 → 容器 /app/input_files
│       ├── 起诉状.pdf
│       └── 借款合同.pdf
├── solution/                        # 参考答案
│   ├── solve.sh                     #   Oracle 入口
│   └── golden_output/
│       ├── 答辩状.docx
│       └── 法规案例检索轨迹.xlsx
└── tests/                           # 评分器
    ├── test.sh                      #   固定模板，见附录 A.1
    ├── finalize.py                  #   固定模板，见附录 A.2
    ├── rubrics.toml                 #   计分 Rubric
    ├── prompt.md                    #   评分 agent 提示词，见附录 6.2
    ├── __golden_output/             #   参考答案
    └── __assets/                    #   可选：评分侧基准材料
1.2 组件清单
组件

必交

大小

作用

instruction.md

是

≤ 1 MiB

任务书，作为 prompt 交给 Agent

task.toml

是

≤ 1 MiB

Harbor 配置 + 元数据 + 交付物清单

rubrics.json

是

—

原始评分细则

environment/Dockerfile

是

—

任务镜像层，含全部依赖

environment/requirements.txt

是

—

执行侧依赖，构建期预装；无依赖交空文件

environment/input_files/

是

计入整批 ≤ 20 GB

全部输入材料

solution/solve.sh

是

—

Oracle 入口（正向预检基准）

solution/golden_output/

是

计入整批 ≤ 20 GB

专家标准答案

tests/test.sh

是

—

固定模板

tests/finalize.py

是

—

固定模板

tests/rubrics.toml

是

≤ 2 MiB

由rubric转换的计分 criteria

tests/prompt.md

是

—

评分 agent 提示词，须含 {criteria} 占位符（见 6.2）

tests/__golden_output/

是

计入整批 ≤ 20 GB

参考答案副本，供判官对照

tests/__assets/

否

计入整批 ≤ 20 GB

评分侧基准材料
1.3 容器内路径与可见性
题包内容

容器内位置

Agent 可见

instruction.md

作为 prompt

可见

environment/input_files/

/app/input_files/（只读）

可见

environment/requirements.txt

构建期预装进镜像

可见

Agent 交付目录

/app/output/（唯一交付目录，工作目录 = /app）

可见（可写）

Agent 日志

/logs/agent/（不作为交付物）

可见

solution/

/solution（仅 Oracle 阶段）

不可见

tests/

/tests（仅评分阶段上传）

不可见

task.toml

文件不入容器

仅 [environment].env 的值可见

评分结果

/logs/verifier/reward.json + reward.txt（单一数值）+reward-details.json（评分明细）；评分不可用时另有 reward_exit_message.json（AP 错误码）

—
1.4 资源默认上限
项

默认值

说明

[agent].timeout_sec

72000（1200 min）

L4/L5长程任务须按实际需要上调

[verifier].timeout_sec

18000

须大于单个 judge 会话超时

cpus / memory_mb / storage_mb

2 / 8192 / 30720

可按需调整

Agent 交付物总量

≤ 2 GB

指 /app/output/

整批 zip

≤ 20 GB

含 inputfiles 与 goldenoutput
2. instruction.md
任务提示词，Harbor 不提供本文件的模板，由供应商自行撰写，但必须限制源文件路径为/app/input_files/，交付文件路径为/app/output/。
2.1 要求
●
自包含：Agent 只能看到 instruction.md、/app/input_files/ 与镜像内预装的工具，任务书必须写全完成任务所需的一切信息，不得引用外部链接或"见附件说明"之外的隐藏语境。
●
列明源文件：逐个列出 /app/input_files/ 下的文件及其字段/口径说明（见 2.2 示例的表格写法）。
●
交付物精确命名：写明交付物必须写入 /app/output/，逐个给出精确文件名——与 [[metadata.deliverables]]、artifacts、两份参考答案、criterion description 逐字节一致（见 3.3）。
●
与 Rubric 对齐：Rubric 的每条显式要求都应能在任务书中找到出处；任务书中的硬性要求也应有对应 criterion 覆盖。
●
不得泄露评分信息：不出现 rubric 条目、golden 内容或"评分将检查……"式提示。
2.2 参考示例
# 钢材买卖合同纠纷案

## 业务场景与任务说明

我是我们MCN机构（也就是合同里的B公司）的法务，主营达人经纪、直播带货和短视频营销这一块。现在商务那边跟我对接了一单业务需要我帮忙审合同，你帮我一起把这个合同过一遍、改一改、出个意见。

事情是这样的：A公司（品牌方，通讯地址在广州，对接人张三）想请我们签约的头部达人王五出席他们品牌直播间，作为嘉宾参与1场直播活动。直播暂定2026年8月21日，地点广州，出席时长4小时（不含妆发和在途交通），直播平台抖音，直播账号是他们的XX旗舰店。除了直播，直播开始前还要王五配合拍摄并发布预热短视频1条、发布预热海报，并给A公司做肖像授权用于宣传投放，肖像授权是30天。预热视频和预热海报都发在抖音。这次合作暂定2026年8月15日开始。合作的品牌产品是一款叫“XX凝胶糖果”的产品。

合同用的是A公司给的模板（就是附件里的《达人活动推广服务合同.docx》），可以在他们模板上改。商务已经跟A公司谈好合作款项含税36万元（税率6%，不含税33.96万多），这个我们很在意付款节点：钱必须在合作正式执行前、也就是王五拍推广视频之前就一次性付清，我们是收到钱之后才开发票。但是我看模板里写的结算方式好像是要我们先提供发票、还要等达人把直播都做完、提供了发票之后甲方才在5个工作日内付款，这个跟我们谈的完全反过来了，你帮我盯紧改过来。我们的底线是：不接受先开票后收款，不接受先履行后收款，也不接受A公司分期付款，就要他们在达人拍推广视频前一次性付款。

你审的时候要站在我们乙方和达人这边。有几个我们特别在意的地方：

第一，A公司这个签约主体我心里没底，你帮我做一个对A公司的主体资信审查，把要查哪几方面的信息列清楚，并且把要用到的检索平台网址也写上，做成《A公司合同主体资信审查.xlsx》给我。检索的过程也帮我留个《检索轨迹.xlsx》。

第二，王五是行业头部达人，我们B公司也是行业头部，所以这单我们是有谈判空间的，能争取的往我们这边争取。我们和王五都非常关注达人的舆情风险条款和违约责任条款。我看模板里塞了一大堆对达人言行的约束，什么直播期间及授权期内不得有犯罪、赌博、酗酒、吸毒、婚外情、出轨、性丑闻、炒作绯闻隐私、拜金炫富之类一长串的行为限制，还挂钩解除合同、退还全部费用，这种对达人言行管得这么死的条款我们要尽量避免，免得哪天有点负面舆情就连锁触发违约。

第三，合同里那几个日期我看着别扭：推广视频拍摄时间、视频成片交付时间、发布时间都写的是暂定2026年8月15日同一天，这不太符合实际操作和商业惯例，你帮我按业务和惯例捋顺。另外合同正文和附件之间也要对得上，别自相矛盾。

第四，关于视频发布的兜底，我们倾向的解决办法是：不管什么原因导致视频没能正常发布、或者发布了没保留够期限就被下架隐藏的，我们希望是补发，而不是退款，你在条款里帮我往这个方向调。

最后要交付的东西是三样加检索记录：《A公司合同主体资信审查.xlsx》、改好的《修订稿-达人活动推广服务合同.docx》、还有一份《合同审查意见.docx》，以及《检索轨迹.xlsx》，文件名就按这个来。资信审查和检索这块，就以2026年8月9日这个时点去查去出结论。

## 可使用的源文件

源文件位于 `/app/input_files/`，**只读**，不要修改：

| 文件 | 说明 |
| --- | --- |
| `达人活动推广服务合同.docx` | 对方提供的模板合同 |

## 交付物要求

交付物必须写入 `/app/output/`，不要把产物写到任何其他绝对路径。

| 交付物 | 是否必交 | 说明 |
| --- | --- | --- |
3. task.toml
3.1 法律题参考示例
schema_version = "1.4"                             # 照抄

# 格式：/app/output/{你的交付物名称}
artifacts = [
  "/app/output/法律尽职调查报告.docx",
  "/app/output/法规案例检索轨迹.xlsx",
  "/logs/artifacts/output",
]

[task]
name = "work/LAW-001"                            # 任务名称
version = "1.0.0"                                # 任务版本
description = "对拟港股 IPO 公司开展法律尽职调查并出具尽调报告"  # 任务描述
keywords = ["LAW", "office",  "L5"]         # [领域英文名, "office", 长程等级]

[metadata]
task_id = "LAW-001"                              # = 题目编号
domain = "法律"                                     # 固定
domain_l2 = "2.4 资本市场"                          # 工作场景分类体系二级标签
capabilities = "IPO尽调全口径法律风险识别与定级、事实与证据梳理、法律法规检索与适用准确性…"                                         #  评测的能力：该任务能评测的具体法律专业能力
vl_dependency = "是"                                # 是否依赖VL（视觉-语言能力）：源文件含扫描件/图片/图表/pdf时=是，否则=否
source_note = "任务来源、真实性保障、真实场景中的交付物是什么"  # 任务说明
tools = "Excel/Python"               # 所需工具（办公工具/数据库，Word/Excel/PPT 等）
domain_knowledge = "公司法与证券法（IPO 发行上市条件）、境外上市规则、律师证券法律业务执业规范…"   # 领域知识依赖（选填）
task_complexity = "L5"               #取值L2-L5
tool_set = ["bash", "python"]                          # 本环境暴露给模型的工具集合
skill_set = []                    # 环境内安装的功能型 skill（= environment/skills/ 下的目录名），详见附录B
expected_tool_dependencies = ["python"]    # 完成任务真正必须依赖的工具
expected_skill_dependencies = []   # 完成任务真正必须依赖的 skill（子集，可为空表示 Skill Discovery 干扰项），详见附录B

[[metadata.deliverables]]    # 交付物一
path = "法律尽职调查报告.docx"     # 交付物一的路径
required = true
desc = "主交付物：法律尽职调查报告"     # 交付物一的描述

[[metadata.deliverables]]   # 见交付物一的说明，如有多个交付物，必须依次写明
TOML 书写：**schema_version**、**artifacts** 必须写在最前面；
先写**[metadata]**，再写 **[[metadata.deliverables]]** / **[[agent]]**等内容。
3.2 Task.toml字段说明表
字段

说明

必填

约束

[metadata].task_id

题目编号

是

格式 LAW-序号，如LAW-001

[metadata].domain

所属领域

是

法律

[metadata].domain_l2

所属领域二级标签

是

对齐知识体系表的领域二级标签，详见
Work法律全场景-题目认领登记表

[metadata].capabilities

评测的能力

是

该任务能评测的具体专业能力

[metadata].vl_dependency

是否依赖VL

是

是 / 否（VL 即视觉-语言能力）

[metadata].source_note

任务说明

是

为什么选这个任务、真实性如何保障、真实场景中的交付物是什么

[metadata].tools

所需工具

是

完成任务所需办公工具/数据库（Word/Excel/PPT 等）

[metadata].domain_knowledge

领域知识依赖

否

完成任务所需的专业知识说明

task_complexity

任务长程性

是

对齐任务长程性分级填L2~L5，详见
Work法律全场景评测数据集构建规则

tool_set

本环境给模型的工具集合

是

填写环境内提供给模型可使用的工具集合

skill_set

环境内安装的功能型skill

否

环境内安装的功能型 skill 目录名，须与 environment/skills/<name>/ 逐一对应；可含干扰项，由模型自行选择skill

expected_tool_dependencies

完成任务真正必须依赖的工具

否

tool_set 的子集：不依赖它任务必失败的 tool。

expected_skill_dependencies

完成任务真正必须依赖的skill

否

skill_set 的子集：不依赖它任务必失败的 skill。

[metadata].expected_pass_rate

目标模型通过率预估

否

0~1

[[metadata.deliverables]]

参考答案（交付物清单）

是

见 3.3

[environment].network_mode

—

是

固定 public。claude-code 框架下不要写 no-network：agent setup 阶段要联网安装 claude CLI，基线断网会直接 AgentSetupTimeoutError、整题跑不起来。确需断网语义的题目，先与平台确认适配方案后再交

[agent].timeout_sec

—

是

缺省 72000
以下格式照抄不改——Harbor 侧要求的字段，与验收无关，按下表要求机械填写，不要自行发挥。
字段

填法

schema_version

"1.4"

artifacts

由交付物清单机械展开：每个 required = true 的 deliverables.path 前面加 /app/output/，不增不减、不改字

[task].name

work/LAW-序号，如work/LAW-001

[task].version

"1.0.0"

[task].description

一句话说明，可直接用 instruction.md 的标题

[task].keywords

["LAW", "office", 任务长程等级]，如 LAW", "office", "L5"]

[verifier].timeout_sec

18000.0

[verifier].user / [verifier.env]

逐字照 3.1 示例：user = "root"；judge 相关变量统一 JUDGE_ 前缀——JUDGE_API_KEY / JUDGE_BASE_URL 必选（运行环境注入，不要替换成真实值），JUDGE_MODEL 等可选项必须用 ${VAR:-默认值} 语法给默认值。ANTHROPIC*/OPENAI不写进 toml，由 test.sh 从 JUDGE_（兜底 EVALAPI*）推导

[environment].os / build_timeout_sec / cpus / memory_mb / storage_mb

逐字照 3.1 示例；确需上调时在提交说明里注明原因
[environment] 只允许 Harbor 字段表内的键：os / network_mode / allowed_hosts / build_timeout_sec / docker_image / cpus / memory_mb / storage_mb / env / healthcheck。不要写 **workdir**——工作目录由 **environment/Dockerfile** 的 **WORKDIR /app** 决定。
[environment].env（agent 侧环境变量）遵循最小必要原则：完成任务不需要的变量一律不配。JUDGE_* 只准写在 [verifier.env]，严禁写入 [environment].env——judge 凭据进 agent 环境等于把评分通道泄漏给被测模型。
3.3 [[metadata.deliverables]]
字段

类型

说明

path

string

相对 /app/output/ 的文件名或 glob；分隔符用 /

required

bool

true = 缺失即判未完成交付；false = 可选产物

desc

string

一句话说明
命名与结构规则
#

规则

原因

1

required = true 必须写精确文件名，禁止 glob / 通配 / "或等价命名"

glob 只允许用于 required = false 的过程性产物

2

文件名不得含日期、时间戳、版本号等动态成分

Agent 每次生成的名字不同，criteria 里写的交付物名永远对不上；业务上需含日期的，把具体字符串写死

3

大小写敏感。清单、instruction.md、artifacts、solution/golden_output/、tests/__golden_output/、criterion description 中引用的交付物路径 六处逐字节一致（含全角/半角、空格、下划线/连字符）

Linux 容器内，Report.docx ≠ report.docx

4

需要目录层级时在 path 中写出；criterion description 里引用交付物时逐个写完整文件路径（如 output/<文件名>），不要只写目录

agent judge 靠 description 里的路径线索找文件，只给目录容易漏查文件、却照 criteria 判"没写"

5

UTF-8，单个文件名 ≤ 200 字节，无控制字符；建议以题目编号为前缀

避免与 Agent 中间产物混淆
4. environment/
4.1 单 Dockerfile 与参考模板
每题一个 environment/Dockerfile，公共依赖直接写全，全部走官方源（Debian / registry.npmjs.org / pypi.org）。禁止使用任何国内镜像源（npmmirror、aliyun pypi 镜像、docker registry mirror 等）：
●
AP 平台部署在境外，官方源直连无加速需求，国内源反而更慢甚至不可达。
environment/Dockerfile（每题一个）：
FROM python:3.12-slim

RUN useradd -m -u 1000 agent

# ① node/npm 是 claude CLI 的运行依赖；中文字体 + libreoffice 供交付物渲染/校验
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git bash jq ripgrep unzip nodejs npm \
        libreoffice-calc libreoffice-writer fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*

# ② 预装 claude-code（钉死版本 2.1.114）：judge 在 verifier 判分容器内运行，harbor
#    安装器不负责该容器，claude 必须镜像内预装。npm 走官方 registry（理由见 4.1 开头）。
#    版本必须钉死：评分行为随 CLI 版本漂移，不锁版本则跨批次分数不可比。
#    若基础镜像/上层环境已自带 claude，不覆盖——只在缺失时安装。
#    ln 到 /root/.local/bin 的软链给 test.sh 的 PATH 前缀用（$HOME/.local/bin）。
RUN command -v claude >/dev/null 2>&1 \
      || npm install -g @anthropic-ai/claude-code@2.1.114; \
    command -v claude >/dev/null 2>&1 \
    && mkdir -p /root/.local/bin \
    && ln -sf "$(which claude)" /root/.local/bin/claude \
    && claude --version

# ③ pip 依赖：rewardkit + 基本的解析库（官方 pypi.org）
RUN pip install --no-cache-dir \
        "harbor-rewardkit[all]==0.1.7" markitdown \
        openpyxl pandas python-docx pypdf python-pptx PyYAML chardet matplotlib

# ④ 本题执行侧依赖（无依赖交空 requirements.txt）
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

COPY input_files/ /app/input_files/
RUN chown -R root:root /app/input_files && chmod -R a-w /app/input_files

RUN mkdir -p /app/output && chown -R agent:agent /app/output

4.2 镜像硬性要求
要求

安装

自检

Python ≥ 3.12，且有 python3

FROM python:3.12-slim

python3 -V

有 bash

基础镜像自带；*-alpine 需 apk add --no-cache bash

bash --version

有 nodejs / npm（claude CLI 运行依赖）

apt-get install nodejs npm

node -v

有 claude 可执行（judge 用，verifier 容器内平台不代装）

见 4.1 模板 ② 预装块

claude --version

harbor-rewardkit[all]==0.1.7，且 rewardkit 在 root 的 PATH 上

pip install --no-cache-dir "harbor-rewardkit[all]==0.1.7"

rewardkit --version

pip 已装文档解析库（markitdown / openpyxl / python-docx /python-pptx / pypdf 等）——judge 读取交付物都依赖它们，缺装会导致判官读不了二进制交付物、大面积判负

见 4.1 模板 ③④

markitdown --help / python3 -c "import openpyxl,docx,pptx,pypdf"

存在 agent 用户，且对 /app/output 可写

useradd -m -u 1000 agent + chown -R agent:agent /app/output

su agent -c "touch /app/output/.w && rm /app/output/.w"

依赖放入requirements.txt中

/

/
构建完成后整体自检：
docker build -t LAW-001 environment/
docker run --rm --network none LAW-001 bash -lc '
  python3 -V && bash --version | head -1 && node -v &&
  claude --version | grep -q 2.1.114 &&
  rewardkit --help >/dev/null && markitdown --help >/dev/null &&
  python3 -c "import openpyxl, docx, pptx, pypdf" &&
  pip show harbor-rewardkit | grep ^Version: && pip check &&
  id agent && su agent -c "touch /app/output/.w && rm /app/output/.w" && echo OK'
末行打印 OK 才算通过。
5. solution/
5.1 solve.sh
运行solve.sh时，应当执行如下逻辑：
#!/bin/bash
set -euo pipefail

mkdir -p /app/output
cp -R /solution/golden_output/. /app/output/

运行后，参考答案主分须 > 0.90。
5.2 参考答案要求
要求

参考答案的文件名、格式、数量与 instruction.md、[[metadata.deliverables]]内 严格一致

须满足 Rubric 的全部正分项

不得命中任何 negate 扣分条目

solution/golden_output/ 与 tests/__golden_output/ 内容一致，目录均不得为空
6. tests/（评分器）
6.1 运行链路（固定）
执行评分时，应当执行如下逻辑 → harness 执行 bash /tests/test.sh → 分数落到 /logs/verifier/reward.json 与 /logs/verifier/reward.txt（单一 int/float），逐条明细由 finalize.py 复制一份到 /logs/verifier/reward-details.json（审计用，缺失不影响主分）；评分不可用时按 AP 规范写 /logs/verifier/reward_exit_message.json（错误码枚举 judge:timeout / judge:api_error / judge:parse_error / judge:scorer_error / judge:invalid_output / judge:unknown，可多级）。
test.sh 与 finalize.py 是平台固定模板，逐字复制、含注释一并保留、不得改动。详见附录 A。
判官是 claude-code agent judge：以 CLI 进程跑在 verifier 容器内，自己用 Bash 工具读交付物（不再由 Reward Kit 预读文件塞进 prompt）。每条 criterion 单独起 1 个 judge 会话独立评分（mode = "individual"，逐条串行）。供应商负责 rubrics.toml和 prompt.md 的内容。
6.2 rubrics.toml 与 prompt.md 示例
tests/rubrics.toml：
[judge]
judge = "claude-code"          # 固定值，判官类型
prompt_template = "prompt.md"  # 固定值，指向同目录 prompt.md
model = "GPT-5.5"         # 裁判模型，照抄
timeout = 7200                 # 单个 judge 会话（individual 模式下 = 每条 criterion 一个会话）的超时秒数
mode = "individual"            # 每条评分点独立评分
weight = 1.0                   # 固定值，照抄

[[criterion]]
id = "R1-P05"
name = "R1-P05"                # 必填，恒等于 id
description = "报告分析税务合规问题时援引以下法规，且法规名称正确，条文序号匹配到条（无需精确到款/项），条文内容摘要及对应关系均与下列正确值一致：
- 法规名称：《中华人民共和国税收征收管理法（2015修正）》第六十二条
- 条文内容摘要：纳税人未按照规定的期限办理纳税申报和报送纳税资料的，或者扣缴义务人未按照规定的期限向税务机关报送代扣代缴、代收代缴税款报告表和有关资料的，由税务机关责令限期改正，可以处二千元以下的罚款；情节严重的，可以处二千元以上一万元以下的罚款。
- 对应关系：适用于分析瀚芯智能湖州分公司因未按期申报印花税和个人所得税被处罚的法律依据，以及判断处罚是否属于情节严重。\nDeliverables to inspect: `output/法律尽职调查报告.docx`, `output/法规案例检索轨迹.xlsx`."
type = "binary"
weight = 10.0

[[criterion]]
id = "R3-N01"
name = "R3-N01"
description = "建议对实际控制人陈启明股份代持及还原情况隐瞒不予披露，或建议在招股说明书中不披露代持还原过程。\nDeliverables to inspect: `output/法律尽职调查报告.docx`."
type = "binary"
negate = true
weight = 10.0

[scoring]
aggregation = "weighted_mean"
三条硬性写法（都对应真实故障或不可复现判分，缺一即整题判分崩溃、静默 0 分或档位随意漂移）：
●
每条 criterion 必须写 name = "<id>"（与 id 相同）。不写时 name 由 description 自动 slugify 生成，纯中文 description 会生成空串，全部条目键塌缩 → Reward Kit 解析崩溃。
●
description 里必须写明待查交付物的完整路径（Deliverables to inspect: 路径格式如 output/<文件名>）。
●
type = "likert" 的条目，必须显式写 points = 5 且在 description 里写明档位锚点——judge 被要求输出 1 到 5 的整数，锚点按 5/4/3/2/1 逐档写明对应的具体情形，见6.6示例。不给锚点，judge 的中间档位给分不可复现、不可审计；锚点写成 0–1 小数则会被输出 schema（integer）拒掉。
tests/prompt.md（可直接复制，把交付物格式按题目实际情况调整）：
You are an evaluation judge with filesystem access. Working directory: `/app`.
Evaluate the candidate's deliverables against the criteria at the end of this prompt.

[Material map]

  /app/output/            THE SUBJECT OF EVALUATION — the candidate's deliverables.
                          Only these files can earn or lose points.
  /app/input_files/       Task inputs given to the candidate (read-only). Consult to check
                          whether deliverables are faithful to what was actually provided
                          (e.g. a cited data source really exists; a stated fact is not fabricated).
  /tests/__golden_output/   One acceptable reference solution. See policy below.

[Reference-solution policy]

The reference is for calibration only — expected structure, field naming, magnitude of
numbers. It is NOT an answer key and NOT a diff target. Two hard rules:

  - Never award points because the reference satisfies a criterion. If the candidate's
    file lacks something, it lacks it.
  - Never deduct for differing from the reference. Different wording, ordering, chart
    choices, or equally valid numbers are not wrong. Reference values are not ground
    truth unless the criterion says equality is required.

Where reference and criterion appear to disagree, the criterion wins.

[Tool usage — technical only, does NOT change scoring policy]

Inspect the deliverables however works best: shell commands, Python, any library in this
container. Work out the approach per file type yourself; nothing here is a required route.
`markitdown <path>` is a handy one-step text extractor for .xlsx/.docx/.pptx/.pdf. This
image was built for this task, so libraries needed for these deliverables are installed —
try importing before assuming one is missing. No network access; no Task/Explore subagents.

If a file genuinely cannot be opened by any available means, say so explicitly in your
reasoning rather than silently treating it as missing or failing.

prompt.md 的六条规则：
1.
**{criteria}** 占位符必须保留——Reward Kit 会把 criterion 列表渲染进去，删掉等于 judge 收不到评分项。
2.
Fairness anchor 段不要删、也不要在 prompt.md 里加任何评分宽严的表述——工具提示被误读成"放宽判分"会使判分严格度漂移。
3.
Material map 段不要删——judge 的 cwd 是 /app，input_files/ 与 output/ 同级可见，tests/ 被挂到 /tests（含 __golden_output/）。三者都在 judge 视野内，模板沉默不等于禁止，只会把"要不要去翻参考答案"交给模型临场决定，同一批次内不同 criterion 会话的口径就此漂移。必须显式写明三区语义。
4.
Reference-solution policy 段不要删、不得弱化——尤其"不得因参考答案满足就给分，一切以候选交付物为准"与"不得逐值比对"两条。前者防的是空产物得分（参考答案里有 ≠ 候选做到了）；后者防的是把参考解当唯一正确答案，对同样有效的不同解法误扣分。
5.
工具提示段保持"提示"而非"强制"——列出容器内可用的解析途径（markitdown CLI、openpyxl / python-docx / python-pptx / pypdf 等库）供 judge 选用，不要写成"必须用某条命令"：判官模型能力不一，部分模型可直接读 PDF 等格式，写死单一路径会挡掉更强的原生能力。环境确有的限制（如 Task / Explore 子代理不可用）照实告知即可，避免 judge 白耗 turn。
6.
总量有上限：prompt.md 模板 + 全部 criterion description 之和须 < 100 KB（prompt 经命令行参数传给 judge，超长会 E2BIG 直接起不来）。
tests/__golden_output/ 是必交目录（见 1.2），在 verifier 容器内挂载为 /tests/__golden_output/，judge 可直接读取——因此 prompt.md 必须写明它的位置与使用政策（见上文规则 3、4 与 6.2 模板的 Reference-solution policy 段）：参考答案仅用于校准结构、字段命名、数值量级，不得逐行/逐格/逐值比对打分，不得因参考答案满足就给分，一切以候选交付物为准，rubric criterion 是得分的唯一权威。
6.3 criterion 字段约束
字段

约束

[judge].judge

固定 "claude-code"。

[judge].model

裁判模型，合法 LiteLLM 模型串，按示例照抄（"GPT-5.5"）。运行时被 REWARDKIT_MODEL（test.sh 由 JUDGE_MODEL 派生）覆盖，toml 值是无注入时的兜底

[judge].prompt_template

固定 "prompt.md"，指向同目录提示词文件（见 6.2）

[judge].timeout

单个 judge 会话的超时秒数。缺省仅 300，必须显式写 7200——agent judge 要反复调 Bash 读文件，远慢于一次性调用；会话超时不写 reward.json，整题无分。[verifier].timeout_sec（18000）须大于本值

[judge].weight

固定 1.0 照抄。不参与主分，只影响 Reward Kit 审计值

[judge].mode

必写 "individual"：每条 criterion 单独起一个 judge 会话评分（逐条串行）。

[scoring].aggregation

固定 "weighted_mean"

[[criterion]].id

必填，题内唯一，rubrics.json 中对应条目的编号保持一致，便于人工追溯

[[criterion]].name

必填，恒等于 id（缺失时中文 description slugify 成空串，解析崩溃，见 6.2）

[[criterion]].description

单条可独立判定的标准 + 待查交付物路径清单；likert 条目还须含各档位锚点。要求见 6.6

[[criterion]].type

只允许使用binary和likert；likert 时 judge 输出 1–5 整数（配合 points = 5），必须在 description 按该标度写档位锚点（见 6.6）

[[criterion]].points

likert 必填，固定写 5（统一 5 档，锚点恒为 5/4/3/2/1）。不显式写时 Reward Kit 也按 5 处理，但必须写出，防止误设其它档数导致锚点与标度错位

[[criterion]].weight

只允许权重出现 3.0 / 7.0 / 10.0 （见 6.4）。扣分只能用 negate = true + 正 weight，绝不能写负数 weight——负 weight 条目会被平台聚合脚本判为异常剔除并记评分不可用（verifier_error = 1），扣分静默失效、整次评分作废重评

[[criterion]].negate

true = 该条描述"候选犯了什么错"；判官判"存在"得 0、"不存在"得 1
6.4 权重档位
重要性

原分数

写法

落点

Critically Important

+10

weight = 10.0+type = "binary/likert"，

rubrics.toml

Important

+7

weight = 7.0+type = "binary/likert"，

rubrics.toml

Slightly Important

+3

weight = 3.0+type = "binary/likert"，

rubrics.toml

Slightly Detrimental

−3

weight = 3.0 + negate = true+type = "binary/likert"，

rubrics.toml

Detrimental

−7

weight = 7.0 + negate = true+type = "binary/likert"，

rubrics.toml

Critically Detrimental

−10

weight = 10.0 + negate = true+type = "binary/likert"，

rubrics.toml
6.5 评分机制
由 finalize.py 全题池化，供应商不自行聚合。
S_max（满分基准）= Σ 全部正向条目的 weight          ← 负向条目不进分母
分子              = Σ 正向 weight × value  −  Σ 负向 weight × (1 − value)
主分 reward       = clip(分子 / S_max, 0, 1)
S_max 覆盖 rubrics.toml下的全部正向计分项。
value 是判官判定的归一化值：
type

value

binary

0 或 1

likert

judge 输出 1–5 的整数（条目统一 points = 5）；Reward Kit 归一化为 (raw − 1) / 4，即1→0、2→0.25、3→0.5、4→0.75、5→1

negate = true 的条目

Reward Kit 自动翻转：1 − 上述归一化值（"完全没违规" = 1.0）
6.6 Rubric 细则要求
Rubric = 一个得分点/扣分点。模型回答到了我们希望的，得分；回答到了我们不希望的，扣分。
五项准则（每条 rubric 先过这五关）：
准则

要求

反例

原子性

一条只判一件事。多个独立要点必须拆条，不得用"且／或"把互不相关的判断绑在一条里

"正确认定合同效力、正确计算违约金、并提出解除建议"——三件事应拆三条

客观性

判定依据写在 statement 内，不同裁判读同一条应得出同一结论。涉及专业判断的，转化为可观察的外部标准

"正确计算违约金"——无法判定；应改为"起诉状中明确主张违约金金额xxx，计算方式为xxxx"

完整性

正向rubric覆盖golden_output 全部核心内容，以确保能充分评价模型交付物与实务可用性的差距；负向rubric覆盖本题埋点对应的全部典型错误答法

埋点设了旧版法规陷阱，却没有对应的负向rubric

自包含

每条rubric包含判定该评分项的全部内容，如具体法律法规规定、具体事实内容、具体风险内容、具体裁判观点，以及是需要满足全部条件才能命中得分、还是满足某一条件即可命中得分，同义表述是否接受等。

写援引《民法典》第一百七十二条规定分析表见代理问题，但没有写明该条文具体法律原文，裁判模型无法据此直接判断被测模型回答是否符合该评分项要求

鲁棒性

表述不受措辞、章节顺序、同义表达影响。凡允许等效表述的，在 statement 内明示可接受范围

要求出现"表见代理"四字，而模型写"构成《民法典》第一百七十二条规定的情形"却不给分
●
打分项 = 一个得分点/扣分点，即考察交付物，
○
符合某一条在实际生产中被要求或有正向收益的打分项，则得分；
○
符合某一条实际生产中应该杜绝或避免的打分项，则扣分。
○
注意：不能在同一个打分角度上，既写得分点，又写失分点，造成双重得分或双重扣分。
●
每条打分项，描述一个具体的、可验证的评分标准，包含以下字段：
description：具体的评判标准描述。
●
单条打分项要求
○
原子性：每条打分项描述一个独立、明确、可验证的评分点，仅检查一个方面（避免一条捆绑多个独立事实/多个可接受值）。
○
准确无歧义：表述完整、事实正确、依据可靠，使不同评分者能够形成一致理解。
○
可独立判断：打分项应包含作出判断所需的关键信息，不要求评分者额外推导、补充标准或进行二次判断。
■
涉及法规引用及分析的，需写明具体法规名称、条文序号、条文内容。

■
涉及具体事实梳理的，需完整写明该类事项核心事实内容，如专利权需写明专利名称、专利号、申请日、权利状态、有效期、权属情况、权利人等完整信息。
○
来源合理：打分项必须来自以下内容，不能凭空增加“伪需求”：
■
任务描述中的明确要求；

■
源文件中的明确要求；

■
根据任务说明和任务场景可以合理推导出的隐含要求。

○
有明确判定锚点：禁止使用“语言流畅”“结构清晰”“内容专业”等空洞描述，应明确说明可观察、可验证的表现。
■
错误示例：法律适用准确。
■
正确示例：引用《中华人民共和国行政处罚法》第三十二条，且写出该条内容并用于论证本案从轻或减轻处罚情节的成立。《中华人民共和国行政处罚法》第三十二条：当事人有下列情形之一，应当从轻或者减轻行政处罚：（一）主动消除或者减轻违法行为危害后果的；（二）受他人胁迫或者诱骗实施违法行为的；（三）主动供述行政机关尚未掌握的违法行为的；（四）配合行政机关查处违法行为有立功表现的；（五）法律、法规、规章规定其他应当从轻或者减轻行政处罚的。须同时满足：①法规名称及条文号准确（第三十二条）；②写出条文内容，仅写条号不得分；③与本案事实建立对应关系，即指出企业已于2024年5月完成污染防治设施整改并经主管部门确认，属于主动消除或减轻违法行为危害后果的情形。\n条文内容允许同义表述，条号与款项序号须准确。。
○
客观可验证：需评价能够直接核查的事实、数据、法律适用、结论等，避免使用“深入”“专业”等主观词语。确需评价主观质量时，必须将其转化为具体的可观察标准。
○
粒度合理：既不要把多个独立要求合并为一项，也不要将一个完整动作拆成大量无实际意义的小项。
●
打分项之间的要求
○
互不重复、互不冲突：不同打分项应评价不同内容，避免同一问题被重复计分，也不能出现判定标准相互矛盾的情况。
○
整体覆盖完整：所有打分项合起来应覆盖任务的主要目标和关键能力，并能够从不同维度评价交付物质量，不能遗漏关键要求。
○
权重体现重要性：同一份打分文件中，应根据各打分项对任务结果的影响程度设置不同的 weight，避免所有打分项机械地使用相同权重。
○
判断结果稳定（鲁棒性）：同一套打分项由不同 Judge 或在不同时间多次评分时，结果应基本一致。若评分结果波动较大，应进一步明确描述、判定边界和示例。
criterion_type：
●
Objective = 可度量、可验证，仅凭回答本身即可作出明确判定；
●
Subjective = 需要裁判模型进行判断与语境解读（如对合同审查立场是否保持委托方立场的判断）。
●
字段约束：criterion_type ∈ {Objective, Subjective}。
criterion_necessity：
●
Explicit = 在 prompt 中逐字明文给出的要求；
●
Implicit = 没有明说但从语境中必然推导出的要求。
●
字段约束：criterion_necessity ∈ {Explicit, Implicit}。
权重weight
●
分值（正分表示奖励，负分表示扣分/惩罚）。
●
不接受恶意负分、故意增加题目难度/降低分数的行为。
●
字段约束为weight ∈{+10、+7、+3、-3、-7、-10}，不能取任何其他值。
●
分值按下表取值：
级别

分数

含义

Critically Important

+10

不满足就是"答错大题"，核心要素

Important

+7

明显增色，但不一定是最低标准

Slightly Important

+3

细节/锦上添花

Slightly Detrimental

-3

小错误、小跑题

Detrimental

-7

重要错误，但整体还能用

Critically Detrimental

-10

致命错误，直接毁掉答案可信度
type
●
字段约束：type ∈ {Binary, Likert}。选择标准如下：
Binary（二元判定）

Likert（分档位给分，接受中间状态）

答案要么满足、要么不满足；中间状态无意义

存在程度差异，且这种差异对最终质量有意义

主观但可明确 yes/no（如"是否有提及不确定性"，提及 or 不提及）

连续指标可以量化（数量、比例、偏离度）
●
likert rubric 示例
likert rubric示例
{
  "id": "R2-P01",
  "description": "模型输出中针对实际控制人股份代持及还原合规性风险的整改建议包含下列关键实质措施（或同类表述）以及对应实质内容：
措施1、建议陈启明与赵慧兰应签署确认函，确认：(1)代持期间陈启明为实际持有人；(2)赵慧兰系根据陈启明意志行使表决权；(3)不存在其他特殊权利约定；(4)不存在权属争议或潜在纠纷。
措施2、建议郑雅琳与郑雅芳应签署确认函，确认代持还原后不再存在代持关系。
措施3、建议瀚芯智能应从股东会层面（陈启明合计控制36.36%表决权，为第一大表决权股东）和董事会层面（7名董事中5名由陈启明提名，包括陈启明、陈宇哲、方秋萍、吴永刚、江国安）两个维度充分论证陈启明为公司实际控制人的认定依据。
措施4、建议瀚芯智能应论证赵慧兰向陈启明转让股权属于代持还原，不构成实际控制人变更。
  评分为1-5整数，按命中的上述关键实质措施数量判定：5=命中全部4项实质措施；4=命中3项实质措施；3=命中2项实质措施；2=命中1项实质措施；1=未命中任何1项实质措施",
  "dimension": "2-交付物内容质量/Q6结论确定性与方案可执行性",
  "criterion_type": "Objective",
  "criterion_necessity": "Explicit",
  "type": "likert",
  "points"：5,
  "weight": 10.0
  }
●
binary 打分项数据示例
binary rubric数据示例
{
  "id": "R2-P08",
  "description":  "法定动作清单中就「提出陈述申辩」这一动作，四项要素齐备且正确：\n①动作：向作出处罚决定的生态环境主管部门提交书面陈述申辩材料；\n②执行主体：被处罚企业（可由其委托代理人代为提交）；\n③时限：自收到行政处罚告知书之日（2024年6月18日）起3日内，即2024年6月21日前；\n④所需材料：陈述申辩书、整改完成情况说明及验收确认文件、危险废物合规处置凭证、企业营业执照复印件、委托代理材料（如委托代理人提交）。\n四项要素须全部齐备且正确方可得分，缺任一要素或时限计算错误均不得分。材料清单允许增列其他合理材料，但上列材料不得缺失。",
  "dimension": "2-交付物内容质量/Q6结论确定性与方案可执行性",
  "criterion_type": "Objective",
  "criterion_necessity": "Implicit",
  "type": "binary",
  "weight": 7.0
}
likert 条目必须显式写 points = 5，并在 description 里写明档位锚点。judge 对 likert 条目输出的是 1 到 5 的整数（Reward Kit 归一化为 (raw − 1) / 4 后计入），锚点必须按 5/4/3/2/1 逐档写明可独立核验的具体情形，不留"judge 自由裁量"的空间。档数统一为 5，不接受其它 points 取值。方向约定：正向条目按满足程度写（5 = 完全满足 … 1 = 完全不满足）；negate = true 的条目按违规程度写（5 = 违规完全成立，Reward Kit 归一化后翻转，计 0 分；1 = 完全无违规，翻转后满分）。
数值算例（points = 5、weight = 7.0）：正向条 raw 5/4/3/2/1 → 计入 +7 / +5.25 / +3.5 / +1.75 / +0；negate 条按违规程度 raw 5/4/3/2/1 → 扣 7 / 5.25 / 3.5 / 1.75 / 0。
负向条目优先用 binary：违规通常"成立/不成立"没有中间态，且负向多档在目前无生产先例、判官一致性缺少验证；确需按违规程度分档扣分时才用 likert，并把每一档写到可独立核验。
可累计扣分（法律原始 rubric 的 trigger_count）的转换：法律原始 rubric 里"每处 −7、可累计"这类按命中次数叠加扣分的负向条目，在 rubrics.toml 中仍写成一条 criterion，不拆成多条 binary；由 judge 依 description 判定命中次数并据此给分——次数或严重程度有档差的，用一条 negate = true 的 likert 承载，在 description 的 5/4/3/2/1 锚点里按命中处数写明（如 5 = 多处严重违规 … 1 = 无违规），命中处数超出档位表达时取最重档；无档差、只需判"有没有"的，用一条 negate = true 的 binary。无论哪种，都必须在 description 内逐项列举本题可能的命中情形，供 judge 判断。
6.7 Rubric 的维度与数量要求
rubric的设计需同时遵循本规范、
Work法律全场景评测数据集构建规则
及
Work法律全场景评测Rubrics设计要求
（统称“数据集构建规则”）的全部要求，本规范主要约定rubric的维度及字段格式，具体内容要求详见数据集构建规则。如本规范与数据集构建规则就同一事项要求不同，以本规范要求为准；本规范未规定事宜，均需遵循数据集构建规则要求。
评价维度dimension
每条 打分项 需要有其所属评分维度。下面定义了综合考虑的维度，主要是引导大家设计打分项的时候思考全面，不遗漏重大维度，并且能有策略专注在价值维度上挖掘打分项。维度根据任务的要求来动态调整，不同的任务需要有区分度。
根据下表给出 打分项 评价的一级维度和二级维度。
●
一级维度
维度

考察内容

1 指令遵循与任务理解【必须】

交付物件数与形态是否齐备、硬约束是否逐项遵守、角色与立场是否按指定身份展开、基准时间点是否被采用

2 交付物内容质量【必须】

下设 Q1–Q7，见 3.2

3 交付物体例规范与可读性

该类文书的法定或惯例体例是否具备（诉状要素、意见书结构、清单字段、表格列头）、层级与编号是否统一等

4 推理与规划（过程评分）

是否按真实工作流推进（先核主体资格再谈条款、先定管辖再谈实体）、是否做了必要的跨文件交叉核验、检索路径是否合理

5 安全合规【必须】

是否给出违法违规建议、是否触碰执业红线、是否编造法源或事实

6 协作体验（可编辑性）

交付物形式是否为可直接使用的形态（合同修订版、可粘贴的条款文本、可套用的清单、标注了待补信息的位置）、是否明示了需委托人确认的事项

7 反偷懒与反模板

是否以"建议咨询专业人士""需进一步核实"回避结论、是否输出与本案无关的通用模板、是否只列标题不写实质内容、应读取的底稿是否未读取
维度 5 的正向rubric可以不设。安全合规的常态是"没有出问题"，把"没有给出违规建议"设成正向加分会让全部合格输出普涨一档，反而压缩区分度；这一维度的rubric集中在扣分负向rubric上。
●
二级维度
每题从下表中选取不少于 3 个二级维度，其中必须包含本题任务类型对应的 2 个领域锚点（见下文“任务类型与领域锚点”）。
编号

二级维度

考察内容

典型正向rubric形态

Q1

事实与证据梳理准确性

从多份材料中提取的事实是否准确完整、冲突材料的采信顺序是否正确、证据"三性"判断是否到位、材料缺口是否被明示

按事实簇单独设立rubric：某一模块的全部核心事实要素齐备且正确

Q2

风险与问题识别完备性

应识别的风险是否逐项识别、风险等级是否与实际严重程度匹配、是否给出判定依据而非仅列结论

每一项预设风险一条rubric，按严重程度分配 +10／+7／+3

Q3

法源定位与援引准确性

援引的法规是否为解决本问题的核心规范、条号与条文内容是否准确、时间效力是否与基准日匹配、案例是否为可比类案

每一条核心法源/类似案例一条rubric，需要具体写明法规名称、条文号及条文原文、案号及裁判要旨

Q4

法律适用与涵摄定性准确性

是否把本案事实正确涵摄到规范要件下、定性结论是否正确、要件是否逐一对应、例外与抗辩是否考虑

每一项定性结论一条rubric，写明正确结论与必要的要件对应关系

Q5

量化计算与门槛判断准确性

金额、比例、期间的计算是否正确、基数与口径是否准确、法定门槛（申报门槛、时效、期限、量刑幅度、罚款幅度）判断是否正确

每一项计算结果一条rubric，写入正确值与容差范围

Q6

结论确定性与方案可执行性

是否给出明确结论、动作是否具体到可执行（主体、时限、材料、路径）、是否提供替代路径、不确定性是否被具体说明

每一项法定动作或方案要点一条

Q7

内部逻辑一致性

同一事实在同一交付物不同章节、或不同交付物的表述是否一致、结论与依据是否匹配、风险等级与处置强度是否匹配、判项与请求是否对应

仅设负向rubric，逐项列举本题可能出现的具体矛盾情形
一致性是交付物的应然状态，故Q7 默认只设负向rubric。
●
任务类型与领域锚点
任务类型决定交付物组合与领域锚点归属。锚点是该类任务在法律实务中最重要的两项能力，两个锚点维度的正向rubric分值之和须占正向满分的 30%以上——低于 30% 说明这道题没有考察关键能力。
任务类型

领域锚点（必选 2 项）

锚点选取理由

F1 咨询研究

Q3 法源定位与援引准确性 ＋ Q4 法律适用与涵摄定性准确性

研究类交付物的全部价值建立在"找对规范、用对规范"上，法源错则结论全错

F2 审查审核

Q2 风险与问题识别完备性 ＋ Q3 法源定位与援引准确性

审查的核心产出是风险清单，漏识别即审查失败；风险的成立须有规范依据支撑

F3 文书起草

Q1 事实与证据梳理准确性 ＋ Q4 法律适用与涵摄定性准确性

文书对外提交后不可撤回，事实引述错误与定性错误直接损害当事人利益

F4 方案设计

Q4 法律适用与涵摄定性准确性 ＋ Q6 结论确定性与方案可执行性

方案的检验标准是"照着做能不能落地"，定性错误与动作含糊都会使方案失效

F5 数据核算

Q1 事实与证据梳理准确性 ＋ Q5 量化计算与门槛判断准确性

台账与测算表的用途是被下游直接引用，基数取错或算错会连锁放大
任务类型不是硬边界。以主交付物形态确定所属类型、锚点按所属类型选取，但可自然带出相邻类型的能力点——IC14 行政处罚应对以 F4 为主，同时含 F1 的法源定位与 F5 的罚款幅度测算，此时 Q3、Q5 作为非锚点维度正常设条即可。
打分项分布要求
●
打分项的分值设计应符合统一标准，能够真实反映各能力的重要程度。主要包括：
○
领域锚点占比：交付物内容质量维度（交付物内容质量下所有二级标签）锚点正分，占全部正分的 30%以上，表示本题对专业性有很高的要求，非简单指令遵循就可满分，要求有极强的领域知识理解。
○
关键项占比：每题至少包含 2 条 Critically Important（+10）评分项，模拟用户真实期望，给出最影响产物本身可用性的打分点。
○
-10分项：仅用于重大专业错误、幻觉、业务安全、合规风险等真正影响答案可信度的情形，不得滥用。
6.8 golden预检
题包提交后我方会进行 golden预检，不达标整题退回：
方向

做法

要求

正向

执行 solve.sh 后的 golden产物跑评分

主分 > 0.90。不达标视为 Rubric 写歪，整题退回重写
本地自测命令：正向 harbor run -p <题目目录> -a oracle。
7. 验收标准
●
单题计分公式：
Score
=
∑
𝑖
∈
𝑃
𝑠
𝑖
⋅
𝑤
𝑖

+

∑
𝑗
∈
𝑁
ℎ
𝑗
⋅
𝑤
𝑗
∑
𝑖
∈
𝑃
𝑤
𝑖
Score=
i∈P
∑
	​

w
i
	​

i∈P
∑
	​

s
i
	​

⋅w
i
	​

+
j∈N
∑
	​

h
j
	​

⋅w
j
	​

	​

𝑤
𝑖
>
0
(
𝑖
∈
𝑃
)
,
𝑃
正打分项；
𝑤
𝑗
<
0
(
𝑗
∈
𝑁
)
，
𝑁
负打分项
w
i
	​

>0(i∈P),P正打分项；w
j
	​

<0(j∈N)，N负打分项

○

𝑠
正
𝑖
=
{
1

binary 正打分项命中
s正
i
	​

={
1
	​

binary 正打分项命中
	​

○

ℎ
负
𝑗
=
{
1

负向打分项命中（产物出错）

0

负向打分项未命中（无惩罚）
h负
j
	​

={
1
0
	​

负向打分项命中（产物出错）
负向打分项未命中（无惩罚）
	​

●
Claude code框架下，跑 Claude opus5、GLM5.3、Kimi-K3、Qwen3.8-max0902中三个模型，裁判模型为GPT-5.5，平均分：(score1+score2+score3)/3小于55%。
●
参考答案得分>0.90 & 三模型平均分 < 0.55
●
至少有一个模型得分。
●
人工质检SOP：打分项、参考答案、hack行为等。
8. 打包与提交
提交时，单题命名统一为：供应商名字+法律+一级任务场景编号+提交时间。如：xx-法律-LS01-20260913。
8.1 目录层级
固定为「批次目录 → 题目目录 → 六件套」，不得多套一层，也不得把题目目录平铺在 zip 根下。
供应商名字+法律+一级任务场景编号+提交时间/     ← 如xx-法律-LS01-20260913。
├── 交付文档.md                     ← 环境变量配置说明等（见 8.4）
├── LAW-001/
│   ├── instruction.md
│   ├── task.toml
│   ├── rubrics.json
│   ├── environment/
│   ├── solution/
│   └── tests/
├── LAW-002/
└── ...
[task] 段缺失时可批量补齐，补齐后仍需手工核对 name 是否符合 3.2 的命名规则（该命令按目录名生成 name）：
harbor task update "path/to/LAW-001" --org "<供应商代号>"
harbor task update "path/to/tasks" --org "<供应商代号>" --scan   # 整目录批量
本地自测（harbor run -p ...）不需要登录 Harbor，供应商代号可自行拟定（建议用组织简拼，全批次固定，返修沿用）。
8.2 提交前自检
#

检查项

1

六件套齐全；environment/requirements.txt 即使无依赖也已交空文件

2

solution/solve.sh、tests/test.sh 为 LF 换行且带可执行位

3

交付物文件名在六处逐字节一致：instruction.md、deliverables.path、artifacts、两份 golden_output/、criterion description 的交付物清单

4

满足 6.7 的条数下限、Critically Important ≥ 2 条、锚点 ≥ 30%、维度分布约束的"总是需要"维度已覆盖

5

weight 只出现 3.0 / 7.0 / 10.0；无负数 weight；type 只出现 binary / likert；likert 条目均显式写 points = 5 且 description 含 5/4/3/2/1 档位锚点

6

本地跑通golden预检：Oracle > 0.90，且 verifier_error = 0

7

task_id 在目录名、[metadata].task_id、[task].name 的 name 段三处一致（按小写连字符规则归一化后比较）；[task].name 的 org 段与批次目录前缀为同一代号

8

题包任何位置无真实密钥 / token / 凭证；需要时用占位符（如 <API_KEY>）并在任务书说明。[environment].env 中不得出现凭证或评分相关信息

9

无残留：.git/、__pycache__/、.venv/、__MACOSX/、.DS_Store，以及本地跑测产生的 reward.json / reward-details.json / logs/ / jobs/

10

所有文件名 UTF-8、单个 ≤ 200 字节、禁止符号链接；整包 ≤ 20 GB

11

rubrics.toml：judge = "claude-code"，每条 criterion 均有 name 且与 id 相同，description 带交付物路径清单；

12

tests/prompt.md 存在且含 {criteria} 占位符；prompt.md + 全部 description 总量 < 100 KB

13

镜像自检（4.2）末行打印 OK：claude --version 输出含 2.1.114

14

toml / prompt.md 中无不可见空白（U+00A0 不换行空格、全角空格 U+3000 等——编辑器粘贴中文文案时易带入，会导致 TOML 解析失败整题判分不可用）

15

[verifier.env] 中 judge 变量均为 JUDGE_ 前缀且可选项带 ${VAR:-默认值}；JUDGE_* 未出现在 [environment].env；[environment].env 满足最小必要原则

16

本地跑完评分后 /logs/verifier/reward.txt 为单一数值且与 reward.json 的 reward 一致；reward-details.json 同时出现在 /logs/verifier/ 与其 graded/ 子目录且内容一致；成功时不存在 reward_exit_message.json，人为制造失败（如清空 JUDGE_API_KEY）时该文件出现且 exit_code 归类正确

17

批次根目录含交付文档（8.4），环境变量表覆盖全部实际使用的变量；
8.3 提交与返修
整批打包成一个 zip 发给对接人，随件注明批次目录名与题目数，并附交付文档（见 8.4，放在批次根目录）。
返修重交：修订题目的 [task].version 递增补丁号（1.0.0 → 1.0.1），只重交修订过的题目目录，批次目录名沿用原名加 _fix<N>（xx-法律-LS01-20260913_fix1），zip 名同步。供应商代号不随返修变更。
8.4 交付环境变量模板
批次根目录放一份交付文档（交付文档.md），包括但不限于环境变量配置说明——以表格逐个说明：
① Key 值；
② 是否必选，可选项写明默认值（数字型说明取值范围与单位；枚举型逐个说明枚举值含义）；
③ 与其他变量的联动关系。本规范标准题包的基线表如下，题包若有增补变量须一并列入：
Key

必选

默认值

类型/取值

说明与联动

JUDGE_API_KEY

是

—（运行环境注入）

string

judge 网关 key。test.sh 派生为 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY / OPENAI_API_KEY

JUDGE_BASE_URL

是

—（运行环境注入）

string（URL）

judge 网关地址，可带 /v1 后缀（test.sh 负责剥除后派生 ANTHROPIC_BASE_URL 等）

JUDGE_MODEL

否

GPT-5.5

string（LiteLLM 模型串）

裁判模型。经 REWARDKIT_MODEL 运行时覆盖  rubrics.toml 的 model；JUDGE_API_PROTOCOL=openai 时同时决定降级 LLM judge 的模型串

JUDGE_PROVIDER

否

anthropic

枚举：anthropic / openai

信息性声明，不改变行为

JUDGE_API_PROTOCOL

否

anthropic

枚举：anthropic / openai

anthropic = claude-code agent judge（默认链路）；openai = 降级为 openai 协议 LLM judge（test.sh 设 REWARDKIT_JUDGE=openai/<JUDGE_MODEL> 覆盖 judge 类型，prompt.md 的工具提示随之不生效）

EVAL_API_KEY / EVAL_API_BASE

否

空

string

旧环境兼容兜底；JUDGE* 已注入时被忽略（test.sh 里 JUDGE* 优先）

LITELLM_DROP_PARAMS

否

true

bool 字符串

网关兼容开关，照抄
注意：judge 会话超时（rubrics.toml timeout = 7200，单位秒）与 verifier 总超时（task.toml [verifier].timeout_sec = 18000）不经环境变量配置，rewardkit 无对应的运行时覆盖钩子，调整须改 toml 并重新交付——此限制须在交付文档中如实说明。
附录 A：固定模板（逐字复制，含注释一并保留）
A.1 tests/test.sh

```bash
#!/bin/bash
# 平台固定模板，请勿改动，直接使用本模板。

set -uo pipefail

# --- judge 凭据：JUDGE_*（task.toml [verifier.env] 声明、平台注入）优先，EVAL_API_* 为旧环境兜底 ---
_JUDGE_KEY="${JUDGE_API_KEY:-${EVAL_API_KEY:-}}"
_JUDGE_BASE="${JUDGE_BASE_URL:-${EVAL_API_BASE:-}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL:-${_JUDGE_BASE}}"
export ANTHROPIC_BASE_URL="${ANTHROPIC_BASE_URL%/v1}"
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-${_JUDGE_KEY}}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-${_JUDGE_KEY}}"
# --- OpenAI 兼容配置（若被降级回 LLM judge 时可用）---
export OPENAI_API_KEY="${OPENAI_API_KEY:-${_JUDGE_KEY}}"
export OPENAI_BASE_URL="${OPENAI_BASE_URL:-${_JUDGE_BASE}}"
export OPENAI_API_BASE="${OPENAI_API_BASE:-${_JUDGE_BASE}}"
# --- 裁判模型运行时可配：rewardkit 原生识别 REWARDKIT_MODEL / REWARDKIT_JUDGE ---
export REWARDKIT_MODEL="${REWARDKIT_MODEL:-${JUDGE_MODEL:-GPT-5.5}}"
# JUDGE_API_PROTOCOL=openai 时降级为 openai 协议 LLM judge（覆盖 rubrics.toml 的 judge 类型）
if [ "${JUDGE_API_PROTOCOL:-anthropic}" = "openai" ]; then
  export REWARDKIT_JUDGE="${REWARDKIT_JUDGE:-openai/${REWARDKIT_MODEL}}"
fi
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
# claude-code 以 root 运行时拒绝 bypassPermissions（--dangerously-skip-permissions
# root 保护）；IS_SANDBOX=1 是官方逃生舱，容器化评测环境属预期场景。
export IS_SANDBOX=1
[ -f "$HOME/.local/bin/env" ] && source "$HOME/.local/bin/env"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"

# rewardkit 调 claude 时不带 --permission-mode，
# 非交互模式默认权限下 Bash/Read 会被拒。
# 写 settings.json 强制 bypassPermissions（claude 启动时自动读取）。
mkdir -p "$HOME/.claude"
cat > "$HOME/.claude/settings.json" <<'SETTINGS'
{
  "permissions": {
    "defaultMode": "bypassPermissions"
  }
}
SETTINGS

if ! command -v rewardkit &> /dev/null; then
  echo "[test.sh] rewardkit executable not found; verifier image must preinstall harbor-rewardkit" >&2
  exit 1
fi

mkdir -p /logs/verifier/graded

# fail-closed 兜底：判分器中途被杀（超时/OOM/容器回收）时，留下的必须是
# "评分不可用"，而不是一个有效 0 分——纯数字的 reward.txt 带不出"不可信"，
# 必须与 reward_exit_message.json 配合。finalize.py 正常收尾会覆盖这些文件
# （成功时删除错误文件）。
echo "0.0" > /logs/verifier/reward.txt
cat > /logs/verifier/reward.json <<'JSON'
{"graded_score": 0.0, "criteria_counted": 0.0,
 "reward": 0.0, "verifier_error": 1.0}
JSON
cat > /logs/verifier/reward_exit_message.json <<'JSON'
{"exit_code": "judge:unknown",
 "exit_reason": "verifier did not finish (killed before finalize.py); fail-closed placeholder",
 "extra_fields": {}}
JSON

# stderr 落盘供 finalize.py 归类错误码：rewardkit 除超时外的所有失败都是未捕获异常，
# 唯一的错误信息就是这里的 Python traceback（同时 tee 到 stdout 便于 test-stdout.txt 排查）。
rewardkit /tests --workspace /app --output /logs/verifier/graded/reward.json \
  2> >(tee /logs/verifier/graded/stderr.txt >&2)
graded_rc=$?

python3 /tests/finalize.py \
  --graded /logs/verifier/graded/reward.json --graded-rc "$graded_rc" \
  --out /logs/verifier/reward.json
```

A.2 tests/finalize.py

```python
#!/usr/bin/env python3
"""平台固定模板，请勿改动。

从 Reward Kit 的逐条判定明细汇总主分（按签名权重池化全题 criterion），
并显式区分"评分不可用"与"确实得零分"。
"""
import argparse
import sys
import json
import math
import pathlib
import re


def load_json(path):
    """读取 JSON；不可读或解析失败返回 None。"""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def load_scores(path):
    data = load_json(path)
    return data if isinstance(data, dict) else None


def finite(value):
    """转成有限浮点数；不可转、NaN、±inf 一律返回 None。

    Reward Kit 只对 judge criterion 归一化到 [0, 1]，程序化 criterion 的返回值
    不钳制（越界只 warn），NaN / inf 会原样写进明细。这类值若直接参与运算会算出
    一个 0 分，看起来像"确实得零分"，必须当成评分异常上报。
    """
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def iter_criteria(details):
    """遍历明细里的全部 criterion。


    details[<维度>] 在该维度只有一个 Reward 时是 dict；judge TOML 与 .py 混用、
    或放了多份 judge TOML 时是 list。两种形状都要处理。
    """
    if not isinstance(details, dict):
        return
    for entry in details.values():
        blocks = entry if isinstance(entry, list) else [entry]
        for block in blocks:
            if not isinstance(block, dict):
                continue
            for item in block.get("criteria") or []:
                if isinstance(item, dict):
                    yield item


def pooled_score(details):
    """全题池化的签名加权分，返回 (分数, 参与条数, 异常条数)。

    正向项：+weight 进分子、weight 进分母。
    negate 项：-weight 进分子、不进分母。明细里的 value 是翻转后的值
              （违规存在 = 0），违规程度需还原为 1 - value。
    异常条目一律不计入、改由 verifier_error 上报，包括：带 error（判官超时会把
    每条都记成 value = 0.0 并保留 negate，若计入会凭空扣分）、weight 非正数、
    value 非有限值、negate 非布尔值。
    无正向条目时分母为 0，主分无定义，返回 (None, ...)。
    """
    numerator = 0.0
    denominator = 0.0
    counted = 0
    broken = 0
    for item in iter_criteria(details):
        weight = finite(item.get("weight"))
        value = finite(item.get("value"))
        negate = item.get("negate")
        if (item.get("error") or weight is None or weight <= 0.0
                or value is None or not isinstance(negate, (bool, type(None)))):
            broken += 1
            continue
        value = min(1.0, max(0.0, value))   # 程序化 criterion 越界返回值的兜底
        if negate:
            numerator -= weight * (1.0 - value)
        else:
            numerator += weight * value
            denominator += weight
        counted += 1
    if denominator <= 0.0:
        return None, counted, broken
    return min(1.0, max(0.0, numerator / denominator)), counted, broken


def count_errors(node):
    """递归统计明细里的 error 字段。judge 超时 / 限额会被记成 0.0 加 error。"""
    total = 0
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "error" and value:
                total += 1
            else:
                total += count_errors(value)
    elif isinstance(node, list):
        for item in node:
            total += count_errors(item)
    return total


def detail_errors(reward_path):
    """扫描 reward.json 同目录下的 *details*.json。"""
    total = 0
    for path in sorted(reward_path.parent.glob("*details*.json")):
        data = load_json(path)
        if data is None:
            total += 1
        else:
            total += count_errors(data)
    return total


def detail_error_messages(reward_path):
    """收集明细里全部 error 字符串。

    Reward Kit 只在**判官超时**这一种情况下写 error 字段（judges.py 的
    ``f"judge timed out after {timeout}s"``），其余失败都是未捕获异常，
    错误信息只在 stderr 的 traceback 里。
    """
    msgs = []

    def walk(node):
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "error" and value:
                    msgs.append(str(value))
                else:
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    for path in sorted(reward_path.parent.glob("*details*.json")):
        walk(load_json(path))
    return msgs


def read_stderr_tail(reward_path, limit=2000):
    """读 test.sh 落盘的 rewardkit stderr 末尾（Python traceback 的末行信息量最大）。"""
    try:
        text = (reward_path.parent / "stderr.txt").read_text(
            encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""
    return text[-limit:]


# Python traceback 的**最后一条异常行**才是真正的错误信息（前面全是栈帧）。
# rewardkit 用 ExceptionGroup 包裹异常，每行带 "  | " 前缀，一并剥掉。
_ERROR_LINE_RE = re.compile(
    r"^[\s|+]*((?:\w+\.)*\w*(?:Error|Exception|Timeout)\b.*)$", re.MULTILINE)


def last_error_line(text):
    """从 traceback 里取最后一条异常行；取不到返回空串。"""
    matches = _ERROR_LINE_RE.findall(text or "")
    return matches[-1].strip() if matches else ""


# Reward Kit 抛出的异常类型 → AP 错误码。左侧字符串取自 rewardkit 0.1.7 源码里
# 逐字写死的异常消息，不是猜测；未命中的一律按 scorer_error 兜底并透传原文。
_EXIT_CODE_RULES = (
    ("timed out after", "judge:timeout"),                    # judges.py 超时（error 字段/warning）
    ("Could not parse JSON from judge response", "judge:parse_error"),
    ("expected dict with 'score' and 'reasoning'", "judge:parse_error"),
    ("exited with code", "judge:scorer_error"),              # agent CLI 非零退出
    ("RateLimitError", "judge:api_error:rate_limit"),        # litellm 异常类名
    ("ContentPolicyViolationError", "judge:api_error:content_filter"),
    ("AuthenticationError", "judge:api_error:auth"),
    ("litellm", "judge:api_error"),
)


def classify_exit(args, result):
    """归类为 AP 错误码，并把 Reward Kit 的原始错误文本原样透传进 exit_reason。

    分类只做三件确定的事：命中源码里写死的异常消息 → 对应码；rewardkit 非零退出
    → scorer_error；跑通了却没有任何有效条目 → invalid_output。其余 unknown。
    无论哪种，exit_reason 都是 Reward Kit 自己的原话（error 字段或 stderr 末尾），
    不做二次加工——排查时看到的应当是判分器实际报了什么。
    """
    detail_msgs = detail_error_messages(pathlib.Path(args.graded))
    stderr_tail = read_stderr_tail(pathlib.Path(args.graded))
    haystack = " | ".join(detail_msgs) + "\n" + stderr_tail
    reason = (detail_msgs[0] if detail_msgs else
              last_error_line(stderr_tail) or stderr_tail[-1000:]) or (
        "verifier marked unavailable without any error output")
    for needle, code in _EXIT_CODE_RULES:
        if needle.lower() in haystack.lower():
            return code, reason
    if args.graded_rc != 0:
        return "judge:scorer_error", reason
    if not result.get("criteria_counted"):
        return "judge:invalid_output", reason
    return "judge:unknown", reason


def compute(args):
    """汇总评分结果，返回要写进 reward.json 的字典。"""
    graded_path = pathlib.Path(args.graded)

    graded = load_scores(graded_path)
    graded_details = load_json(graded_path.with_name("reward-details.json"))

    dims = {}
    for key, value in (graded or {}).items():
        if key == "soft_score":
            continue
        number = finite(value)
        if number is not None:
            dims[key] = number

    # 主分：按签名权重池化全题 criterion（负向项真扣分，空产物下限为 0）。
    pooled, counted, broken = pooled_score(graded_details)
    score = 0.0 if pooled is None else round(pooled, 6)

    # Reward Kit 自己的 [0,1] 归一化聚合值，仅留作审计参照，不作主分。
    soft = finite((graded or {}).get("soft_score"))
    if soft is not None:
        soft = round(soft, 6)

    graded_ok = (args.graded_rc == 0 and bool(dims) and pooled is not None
                 and counted > 0 and broken == 0)

    result = dict(dims)
    result["graded_score"] = score
    result["criteria_counted"] = float(counted)
    if soft is not None:
        result["soft_score"] = soft
    # 评分不可用时主分一律记 0：宁可保守低估，也不要因为把异常条目排除在分母之外
    # 而把剩下的条目重新归一化成一个虚高的分数。真实分数留在 graded_score 里。
    unavailable = not graded_ok
    result["reward"] = 0.0 if unavailable else score
    # 平台读取：1 = 本次评分不可信（判官限额/超时/评分器异常），须重评而非记零分。
    result["verifier_error"] = 1.0 if unavailable else 0.0
    return result


def main() -> int:
    # 被 rewardkit discover() import 时不得有副作用：它会把 tests/ 下所有 *.py
    # 都 import 一遍。若 argparse 留在模块级，import 即 SystemExit 杀死评分进程。
    parser = argparse.ArgumentParser()
    parser.add_argument("--graded", required=True)
    parser.add_argument("--graded-rc", type=int, required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    try:
        result = compute(args)
    except Exception:
        # 未预期的异常也必须落地一份结果：缺了 reward.json，平台读到的是"这道题没跑过"，
        # 与"跑出 0 分"无法区分。一律记 verifier_error = 1 交平台重评。
        result = {"graded_score": 0.0, "criteria_counted": 0.0,
                  "reward": 0.0, "verifier_error": 1.0}

    out_path = pathlib.Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

    # ---- AP 标准化输出 ----
    # reward.txt：单一数值（覆盖 test.sh 开头的 fail-closed 占位）。
    out_path.with_name("reward.txt").write_text(
        f"{result.get('reward', 0.0)}\n", encoding="utf-8")
    # reward_exit_message.json：仅评分不可用时存在；成功则删除 fail-closed 占位。
    exit_path = out_path.with_name("reward_exit_message.json")
    if result.get("verifier_error"):
        try:
            code, reason = classify_exit(args, result)
        except Exception:
            code, reason = "judge:unknown", "classification itself failed"
        exit_path.write_text(json.dumps({
            "exit_code": code,
            "exit_reason": reason,
            "extra_fields": {
                "criteria_counted": result.get("criteria_counted", 0.0),
                "graded_score": result.get("graded_score", 0.0),
                "rewardkit_rc": args.graded_rc,
            },
        }, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        exit_path.unlink(missing_ok=True)
    # reward-details.json：逐条明细随主分一并落到 out 同目录（rewardkit 写在
    # --output 旁的 graded/ 子目录）。审计便利件，不参与 fail-closed 契约：
    # 缺失或拷贝失败不影响主分与错误码归类，静默跳过。
    graded_details = pathlib.Path(args.graded).with_name("reward-details.json")
    if graded_details.is_file():
        try:
            out_path.with_name("reward-details.json").write_text(
                graded_details.read_text(encoding="utf-8"), encoding="utf-8")
        except OSError:
            pass
    # 退出码恒 0：评分不可用由 reward.json 的 verifier_error 承载，
    # 非零退出会被平台当成 finalize 自身崩溃、丢掉已写好的结果。
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

附录B：含Skill类任务说明
1.
含Skill类任务分类
1.1
Skill Discovery
提供多个 Skill, 要求模型自行判断：是否需要 Skill，以及应该使用哪个 Skill。
1.2
Skill Dependency
构造：
没有 Skill 中的特殊知识 / 行为规则，模型很难正确完成任务。
推荐构造方式
1.2.1
类型一：特殊业务规则
Skill 明确规定：当两个 authoritative source 的关键字段冲突时，禁止自行选择，必须暂停并向用户确认。
Task 中主动埋入这种冲突。模型如果没有真正遵循 Skill：最终一定会进入错误 branch。
1.2.2
类型二：环境特化 SOP
例如 Skill 定义某企业内部审批流程：Draft → Compliance Review → Manager Approval → Publish
Task 要求完成发布。如果模型直接：Draft → Publish。最终 Workflow State 必须失败。
1.2.3
类型三：特殊计算 / 判定规则
Skill 中包含：特殊阈值；内部映射规则；自定义字段定义；业务优先级；fallback 顺序。要求这些内容直接影响 final answer。
1.3
Skill Generation / Editing
可以增加一批：创建 Skill；修改已有 Skill；从 SOP 抽取 Skill；Skill migration；Skill package repair之类的任务
2.
Skill形态说明
●
当前可以主要通过写入到skills文件夹下的形式
2.1
功能型Skill的标准目录结构
LAW-002/
├── task.toml                      # 任务声明
├── instruction.md                 # 显式说明"通过 contract-redliner skill 完成，禁止其它方式改文档"
├── environment/
│   ├── Dockerfile                 # COPY skills/ /skills/  ← skill 在这里被装进环境
│   ├── skills/
│   │   └── contract-redliner/
│   │       ├── SKILL.md           # Anthropic Skill 格式：frontmatter(name/description/compatibility)+正文SOP
│   │       ├── scripts/           # read_document.py / propose_edits.py / add_comment.py …
│   │       └── references/        # anchors.md 等被 SKILL.md 引用的补充规则
│   └── app/                       # 任务输入：contract.docx + grounding 材料
├── tests/
│   ├── test.sh → run_verifier.py  # 判分入口
│   └── rubrics.json               # 判据
└── solution/
    ├── solve.sh
    └── ground_truth.docx          # ground_truth
SKILL.md 的写法参考：
---
name: contract-redliner
description: Redline Word (.docx) contracts with native tracked changes and margin comments … Use when asked to redline, mark up, revise a .docx legal document — every edit must be a real tracked change applied via the bundled scripts, never by rewriting the file.
compatibility: Requires Python 3.10+ with python-docx==1.2.0, docx-revisions, lxml.
---

# Contract Redliner
（正文：分步 SOP、脚本用法、失败恢复、"绝不能用别的方式改文档"的硬规则——
 这些"特有行为规则/阈值/映射"就是让 Skill 不可省略的关键
注意instruction.md 里需要显式强调下要使用该skill：
Every edit and every comment goes through the contract-redliner skill installed in this environment — never write [ADD:…]/[DELETE:…] markup, and never modify the document by any other means.
