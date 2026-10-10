<!-- 文件职责：项目入口说明、开发导航、运行边界与主要工作流概览。 -->
# ai-distill

多项目出题工作台，以项目中的题目目录为工作流单元。当前包含七个可见步骤：入库（含 PDF 文本提取）、脱敏与检查、出题、模型作答、独立评分、达标或返修、发布成果与导出。出题读取步骤设置及本地项目 skill；评分 Agent 只读取题面、rubric、匿名答案和评分步骤提示词；作答思路与标准答案留在系统内部校验；附件正文从数据库读取脱敏版本，脱敏步骤读取数据库原文。模型作答只收到题面和允许的脱敏附件，不读取项目 skill、rubric 或标答。独立审查已从新工作流移除，历史记录保留但不参与前置校验。真实卷宗完整闭环、自动返修恢复及正式交付须按具体证据验收，不能从入口存在推断通过。

## 文档与模块导航

- [系统结构与架构设计](docs/architecture.md)：模块关系、数据流、稳定步骤身份、运行与验收边界。
- [项目协作规则](AGENTS.md)：修改范围、数据不变量、运行授权及文档维护。
- [后端](server/README.md)与[前端](web/README.md)：模块入口与各目录说明。
- [共享契约](shared/README.md)、[提取配置](config/README.md)、[数据库迁移](migrations/README.md)、[人工脚本](scripts/README.md)。
- [项目资料目录](projects/README.md)与[历史文档／证据](docs/README.md)。

根级配置的文件用途与编辑边界：`package.json` 定义 Bun 命令和依赖声明；`bun.lock` 是依赖锁文件，不能手工改写；`tsconfig.json` 配置根 TypeScript 编译范围；`.env.example` 是不含真实凭证的环境变量模板；`.gitignore` 定义本地凭证、依赖和产物的忽略规则。锁文件和 JSON 不支持注释，以本段作为文件级说明。`web/package.json`、`web/tsconfig.json` 的用途见 [前端说明](web/README.md)。

以下运行命令是操作参考，遵守 AGENTS.md 的授权限制，不是自动执行指令。历史记录中的“已验证”只代表当时注明的范围。

## 技术与入口

Vue 3 + TypeScript + Vite + UnoCSS + Vuetify；Bun + Hono；Neon PostgreSQL + pg。接口与后台执行使用独立入口，首阶段接收材料在接口事务内完成，worker polls queued tasks every 3 seconds when started。

```sh
bun install --frozen-lockfile
cp .env.example .env
# 在本机填写 DATABASE_URL，勿提交凭证
bun run migrate
bun run server
```

另一个终端启动界面：

```sh
bun run dev
```

打开 http://127.0.0.1:5173 。可选执行入口：`bun run worker`。worker 当前处理入库／PDF提取、脱敏、skill 候选、出题／质检、作答、独立评分及显式返修链接续。达标与发布入口由对应服务处理；出题、审查读取步骤提示词及本地项目 skill，评分只读取题目包、答案和评分步骤提示词，不需要编号规则绑定。Agent 默认并发 2（安全范围 1–4），API 默认并发 8（安全范围 1–8）；在“系统设置”调整后需重启 API 和 worker 生效。材料接收／提取另为 2 路。

## iTerm2 一起启动

已安装依赖并配置 `.env` 后，在 macOS 上执行：

```sh
npm run start:iterm
```

脚本打开一个 iTerm2 窗口，在三个页签分别启动后端、前端和材料处理进程；可从任意目录使用脚本绝对路径启动。不会自动迁移数据库。重复启动会复用代码未更新的本项目服务；发现 API／worker 源码比进程新时，仅在监控确认没有运行中任务后正常停止旧进程并启动新进程。任务状态无法确认或仍有运行中任务时会停止启动并提示，不会强制杀进程；端口被其他程序占用时明确报错。停止服务仍可回到原启动终端按 `Ctrl+C`。

## 使用

1. 创建出题项目，必须填写本机材料文件夹绝对路径：`项目目录/题目 1/附件.pdf`、`项目目录/题目 2/多份附件.pdf`。每个直接题目子目录建立一条工作流，题目目录内可包含子目录；系统不修改来源文件夹。项目可编辑和删除。
2. 本地skill目录可填写包含SKILL.md的现有目录，留空创建本项目独立目录。尚未生成 SKILL.md 时显示待生成；可生成候选并采用为当前项目 skill。新任务读取采用时的本地文件并按本次任务指纹校验，不再要求规则版本登记或冻结。
3. 项目详情默认“执行步骤”：每步展示就绪、排队、运行、成功、失败数量。第一步统一入库；PDF需等待文本提取成功才完成，DOCX/TXT/MD本地解析后直接完成。第二步只处理第一步已入库的原文。单条失败不阻挡其他条，worker使用两路并发。
4. 点击步骤名称或“查看题目”打开统一题目表格，查看状态、原因和结果；步骤设置保存模型及该步骤提示词。入库 PDF 使用固定提取 provider，脱敏默认使用独立大模型 API，可在脱敏设置中切换为本地 Agent（Codex）；API 缺少供应商或模型配置时提示配置，不自动切换 Agent。出题在执行时读取当前本地项目 skill；评分不读取项目 skill。作答按项目模型集合派发，要求当前出题成功并符合文字无工具契约。
5. “题目记录”查看单条题目执行情况。进入题目可查看七个可见步骤、材料、结果和历史，增加/替换/删除材料。修改附件会取消旧的活动任务并使下游当前结果失效；历史保留，原始来源文件夹不修改。
6. 点击第一步“入库”时会重新扫描该题目目录并刷新清单，因此新增、移除或修改文件后可直接入库；“同步题目目录”用于批量发现新题和刷新项目内所有题目。未变化的材料不会重复接收。项目删除为逻辑删除，保留原件与历史，停止后续任务派发。
7. “资料与 skill”查看和管理本地项目文件。工作区填写该期根目录；文字资料可编辑，其他支持文件可上传替换，删除需要当前指纹。skill在页面只读，在本地修改后刷新。步骤任务按当前 skill 建立本次输入指纹；若文件在任务执行期间变化，旧结果不提交，重新派发后读取新内容。旧规则版本和隐藏 ordinal 3 记录仅保留为历史数据，不阻挡新任务。

旧项目可以继续查看和操作材料；首次按目录接收前，请编辑项目补充材料根目录。本地worker须运行：`bun run worker`，或使用`npm run start:iterm`同时启动前后端和worker。每次批量最多100条。

接收验证扩展名、大小及PDF头标识。PDF提取记录页码、提取方式与异常；DOCX/TXT/MD在入库时本地解析。原文件始终保持原样，原始文本作为受限产物保存于数据库。

单文件不超过50MB，一个材料包最多100份、合计100MB。相同文件名不会覆盖；上传使用幂等键防止同次请求重试创建重复工作流。换一个材料包再次上传相同文件允许保留独立记录。

## 数据与运行边界

所有业务表位于 `ai_distill` schema，不修改数据库其他schema的业务表。迁移只通过 `bun run migrate` 显式执行，并记录应用版本。文件默认保存在 `.storage/`；改路径须同步搬迁原件。数据库备份不包含本地文件，两者需要一起保留。

`.env`、原文件和依赖目录均不入Git。本地 `.env` 建议权限600。数据库连接校验TLS证书并按配置启用channel binding。接口和前端只监听127.0.0.1，首版没有用户登录和远程访问功能。

前端刷新按钮请求当前状态；工作流详情仅在任务排队或执行中每3秒刷新，空闲时不轮询。

## 验证命令

```sh
bun run test:backend
bun run build
bun run check
```

`bun scripts/verify-integration.ts` 使用独立临时Neon schema验证接口、持久化队列、同步等待，以及指定PDF第一页的真实智谱识别和独立脱敏。`VERIFY_FULL_PDF=1 bun scripts/verify-integration.ts` 验证整份文件；可用`VERIFY_PDF_PATH`指定其他PDF。OCR调用智谱，脱敏调用Codex；退出时删除临时schema与材料，验收记录不保存原文。主业务数据不受影响；第一页通过不代表整份卷宗通过。

自动导入类型声明随源码保留，首次构建也可直接检查类型。后端测试关注上传验证、文件与事务失败清理、幂等重试及尚未接入阶段不会成功。前端不创建测试；实际页面、数据库及原件下载另做集成核对。

阶段规划见 `docs/plans/2026-10-07-workflow-mvp.md`。

## 前端结构与界面

`web/` 是独立前端包，根目录命令委托该包执行。`web/src/theme.ts`、`web/uno.config.ts` 沿用 ai-news 的设计变量及语义快捷类；Vuetify 提供表单、弹窗、页签和按钮，Row/Column 负责布局。

界面包含侧栏、项目统计与搜索、项目页签、材料上传弹窗、工作流时间线和原件信息。统计来自实际数据，未接入功能明确标注待开放。

本次改版已通过构建、前后端类型检查及前端代理健康接口核对。项目列表、新建项目弹窗、步骤页及题目记录已做桌面浏览器核对；移动端和完整浏览器文件上传尚未验收。

## PDF processing

PDF提取配置位于 `config/extraction.json`：第一步创建任务时保存配置快照，进行中的任务不切换配置。DOCX/TXT/MD由本地解析器直接转换为逐页文本并与材料信息一同写入数据库，不调用OCR。脱敏提示词及Codex模型设置独立保存在第二步项目配置中。代码更新后需重启 API 和 worker；进行中的任务使用自己的快照，修改默认配置不会覆盖它们。

运行 `bun run migrate` 后启动 `bun run worker`。PDF提取配置 `ZHIPU_API_KEY`、`ZHIPU_BASE_URL` 和 `ZHIPU_MODEL`；worker异步提取PDF并将原文与页索引保存到数据库。第二步读取已入库文本执行脱敏，另存脱敏Markdown及页索引；两步的尝试记录分别保留。扫描页调用智谱会产生服务费用，失败任务可重试。

入库、PDF提取和脱敏接口默认异步返回202及任务ID；等待参数只控制请求等待窗口，不改变后台任务。任务进入成功、失败或跳过后返回200及实际状态；等待结束仍在运行时返回202、`completed=false`及同一ID。客户端断开不取消后台任务。`GET /api/attempts/:id`读取状态及结果，也支持`wait_ms`；`completed=true`仅表示进入终态，是否成功以`status`为准。后台worker须另行运行。

单次智谱 OCR 请求及 PDF 工具等待上限为 30 分钟，与 API 的同步等待窗口独立。页级截断、空页和识别异常会随已提取文字入库并保留在问题列表中，不阻断入库；这不代表每页文字已人工核验。脱敏检查在第二步独立完成。

`bun scripts/verify-input-versions.ts` 使用真实PostgreSQL临时schema及合成PDF测试并发导入、附件更新与晚到结果隔离，不调用识别服务。结果保存在 `docs/evidence/input-version-results.json`；这项验证不能代替真实PDF识别或浏览器目录选择验收。

`bun scripts/verify-project-folders.ts` 使用真实数据库临时schema与合成PDF验证项目文件夹入口、步骤就绪筛选、材料修改及逻辑删除，不调用模型。详情见[项目工作台验收](docs/evidence/project-folder-workbench.md)。

## 本地出题项目

每一期存于`projects/`独立文件夹。目录结构、文件说明和数据库职责见[项目目录说明](projects/README.md)；首期规则和skill见[第五期资料说明](projects/豆包高经济价值-第五期/README.md)。skill原文保留本地，数据库登记路径和版本指纹。

历史证据 `docs/evidence/rule-workspace-verification.md` 记录了旧规则版本功能的验收范围；该流程现已退出新任务路径。`bun scripts/verify-codex-isolation.ts`只验证本机CLI沙箱的文件读写边界，不调用模型，不代表Codex执行器已经接通。

## Qwen 独立作答客户端

`server/answer-models/qwen.ts` 已提供纯文字作答客户端与安全错误分类，模型作答步骤页面配置、入队和答案结果入库/下载已接线；服务端作答入口要求当前出题步骤成功。服务端配置 `QWEN_API_KEY`（也可用 `DASHSCOPE_API_KEY`）、`QWEN_BASE_URL` 和 `QWEN_MODEL`；Key 与端点地域须匹配，Base URL 不包含 `/chat/completions`。模型与端点无默认值，思考参数支持范围以所选模型为准。

也支持通过 `OPEN_ROUTER_KEY` 调用 Qwen：仅配置普通 OpenRouter 调用密钥时，使用 `https://openrouter.ai/api/v1` 和 `qwen/qwen-plus`；可用 QWEN_BASE_URL/QWEN_MODEL 覆盖。管理密钥不能作答。不同端点只使用各自的密钥，不在失败后自动切换。

针对性测试：`bun test server/answer-models/qwen.test.ts`。真实冒烟：`bun scripts/verify-qwen.ts`，只发送合成文字材料，配置齐备时调用一次收费 API；缺配置退出码2。实现、证据及主流程接线边界见[Qwen 接入验收](docs/evidence/qwen-independent-integration.md)。

模型作答步骤与评分校验的产物格式、版本隔离及验收边界见 [输入与评分契约](docs/plans/2026-10-08-answer-input-and-score-contract.md)。作答入口不再要求 ordinal 10 独立审查；旧审查尝试仅保留为历史。`migrations/005_answer_queue.sql`补充模型作答步骤标记和队列索引；已通过项目迁移流程应用至当前配置数据库；其他部署按正常迁移流程应用。

## Codex 执行器当前状态

底层客户端已实现 ChatGPT 套餐登录检查、受限文件权限、结构化产物与事件记录、30 分钟超时和取消。真实 gpt-6.1-sol 调用通过；保留网络代理但不向子进程转发数据库或提供商密钥。skill 生成、出题、独立评分及脱敏业务已连接；独立审查步骤已从新工作流移除，旧执行复盘保留其发生时边界。接线不等于真实卷宗验收。当前结构见 [架构设计](docs/architecture.md)。

新任务不执行隐藏的规则版本绑定步骤。出题读取步骤设置与项目当前本地 skill，并记录文件指纹；评分读取同版题目包、匿名答案和评分步骤提示词，保留版本绑定。模型作答只读取题面及数据库中的脱敏附件。ordinal 10 独立审查仅保留历史记录，不在新任务中执行或作为后续步骤门槛。旧规则加载验收仅代表历史实现，见 [固定规则加载](docs/evidence/2026-10-08-rule-loading.md)。

## 模型作答步骤多供应商与执行器监控

模型作答步骤可选择 Qwen、Kimi、DeepSeek 或豆包，每次任务固定一个供应商和模型；配置及版本、完整答案、usage和安全错误沿用现有持久化队列。原生接口使用 `.env.example` 中各自的服务端密钥及显式模型ID，不会自动改走OpenRouter或切换模型。Kimi还支持MOONSHOT_API_KEY，豆包支持ARK_API_KEY。已支持项目模型集合逐模型派发与结果汇总，达标判断按当前集合和每模型阈值执行；真实题目完整多模型流程仍需验收。

worker每5秒采样，系统可用内存估算低于 WORKER_MIN_AVAILABLE_PERCENT（默认10）时暂停领取新任务，恢复后继续；正在运行的任务继续。内存读取未知时明确标记unknown并沿用派发策略。`GET /api/monitor`读取本地安全快照，项目列表显示状态；超过30秒标为过期。API和worker须使用同一 STORAGE_DIR，仅支持一个本地worker。当前采集worker进程、Agent登记的Codex CLI子进程、数据库等待／运行任务和心跳；认证状态与套餐额度仍标记为unknown。更新后需重启API和worker。

接线验收和边界见 [第四阶段接线验收](docs/evidence/phase-four-wiring.md)。

## 独立评分步骤独立评分

先保存独立评分步骤Codex模型与推理强度，再通过项目批量按钮或题目详情“独立评分”入队。`POST /api/workflows/:id/score`支持同一任务的wait_ms等待；worker单通道读取持久化任务，使用独立匿名输入目录与会话，发送同版题面、rubric、实际脱敏附件和匿名答案，不发送作答思路、标准答案、目标分数或作答模型身份，不读取项目 skill。报告逐条评分与程序校验结果保留，争议或无效评分显示失败，评分报告可下载；usage不换算为套餐单题价格。更新部署需运行迁移及重启API/worker。

`bun scripts/verify-answer-flow.ts`以临时PostgreSQL schema和注入模型验证；加`--real-score`只把首个评分任务改为一次真实Codex套餐调用，题目和作答仍为合成夹具。它不能证明真实材料七步可见流程闭环已完成。

## 单题生成数据清理

题目详情的“重置整条工作流”删除本题全部步骤执行记录、入库文本、脱敏内容及生成产物，清空OCR缓存并将步骤复位到待入库；保留题目、附件入库记录和本机原始附件。运行中的任务禁止重置；通用自动运行控制已撤除。接口为 `DELETE /api/workflows/:id/generated`；现有删除题目接口仍是逻辑删除。

## 项目 skill 候选生成

资料与skill页可用显式Codex模型配置提交项目级生成任务，使用完整company-legal-task模板和当前项目资料；worker与独立评分共用一个Codex通道。任务、心跳、候选目录和问题清单持久化；候选不会覆盖当前skill，采用后更新项目当前 skill 路径。可用SKILL_BASE_TEMPLATE_DIR指定服务端基础模板目录。外部资格及平台当前规则未确认保留问题记录，内部必要规则缺失/冲突才阻断内部采用。

## PDF提取与入库

PDF解析独立封装在 `server/materials/pdf-extraction/`，通过 `PdfExtractionProvider` 接口对接解析器。当前支持 GLM OCR 和 MinerU CLI；配置 `MINERU_KEY` 后默认使用 MinerU CLI，也可通过 `PDF_EXTRACTION_PROVIDER=glm-ocr` 固定使用 GLM。MinerU CLI 安装到 `.storage/tools`：

```sh
mkdir -p .storage/tools
INSTALL_DIR="$PWD/.storage/tools" sh -c "$(curl -fsSL https://cdn-mineru.openxlab.org.cn/open-api-cli/install.sh)"
```

MinerU 通过异步云端服务完成 `vlm + OCR`，本机只负责 CLI 和文件处理；解析后的页级文本及异常状态沿用现有格式写入私有产物。后续可在同一接口下增加 MinerU API 实现而不改材料队列。卷宗会上传给 MinerU 服务，须按项目数据要求选择是否使用。识别结果仍需逐页复核，数据库入库不代表全文已核验。DOCX/TXT/MD继续由本地解析器读取后直接入库；第二步由Codex读取原文执行独立脱敏。

大模型 API 调用入口见 [llm-api 模块](server/llm-api/README.md)，与本地 [Agent 模块](server/agent/README.md) 并列；作答统一调用 API 模块，脱敏可在两种执行方式之间选择。脱敏默认 OpenRouter GLM-5.3-Flash，复用已有 `OPEN_ROUTER_KEY`；步骤只选择系统目录中的模型，不重复填写供应商或 URL。`LLM_API_*` 可覆盖统一默认值，本次没有写入实际环境配置。
