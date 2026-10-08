# ai-distill

多项目出题工作台。项目创建、材料原件与SHA-256保存、八步状态及处理历史已实现。第一步统一为“入库”：PDF先经智谱提取文本再写入数据库；DOCX/TXT/MD在本地解析后直接入库。第二步单独执行脱敏与检查。批量处理和输入版本追溯已接入；真实整份扫描卷宗的智谱识别验收仍未通过。第三阶段已接入本地规则资料及完整skill的查看、资料编辑和版本冻结；第五步Qwen配置、队列、答案留存及评分结构校验已接入；skill生成、出题与独立评分执行器尚未接入。

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

打开 http://127.0.0.1:5173 。可选执行入口：`bun run worker`。当前 worker 处理第一步材料入库（含PDF提取）、第二步独立脱敏及第五步模型作答；第三步固定规则加载已接入；第四、六、七、八步执行器待接。材料两路并发，作答独立四路。

## iTerm2 一起启动

已安装依赖并配置 `.env` 后，在 macOS 上执行：

```sh
npm run start:iterm
```

脚本打开一个 iTerm2 窗口，在三个页签分别启动后端、前端和材料处理进程；可从任意目录使用脚本绝对路径启动。不会自动迁移数据库。重复启动会复用已运行的本项目服务；端口被其他程序占用时明确报错，不自动杀进程。复用页签只显示提示，停止服务须回到原启动终端按 `Ctrl+C`。

## 使用

1. 创建出题项目，必须填写本机材料文件夹绝对路径：`项目目录/题目 1/附件.pdf`、`项目目录/题目 2/多份附件.pdf`。每个直接题目子目录建立一条工作流，题目目录内可包含子目录；系统不修改来源文件夹。项目可编辑和删除。
2. 本地skill目录可填写包含SKILL.md的现有目录，留空创建本项目独立目录。尚未生成SKILL.md时显示待生成；skill生成执行器还未接入。
3. 项目详情默认“执行步骤”：每步展示就绪、排队、运行、成功、失败数量。第一步统一入库；PDF需等待文本提取成功才完成，DOCX/TXT/MD本地解析后直接完成。第二步只处理第一步已入库的原文。单条失败不阻挡其他条，worker使用两路并发。
4. 点击步骤名称或设置按钮进入配置。第一步的PDF提取使用智谱配置；第二步使用独立的Codex脱敏配置。后续Codex步骤可先存设置，第5步已接入Qwen设置和队列；只处理已通过第4步质检、符合纯文字无工具契约的题目。第3步加载已冻结快照；第4、6、7、8步执行器尚未接入。
5. “题目记录”查看单条题目执行情况。进入题目可查看八步、材料、输入版本、结果和历史，增加/替换/删除材料。修改增加输入版本并使旧的下游任务及结果失效；历史保留，原始来源文件夹不修改。
6. 来源目录增加或修改PDF后，点击“同步题目目录”发现新题或变化，再执行第一步。未变化的目录不重复接收。项目删除为逻辑删除，保留原件与历史，停止后续任务派发。
7. “资料与 skill”查看本期materials、完整skill及规则版本。工作区填写该期根目录，登记当前指纹；文字资料可编辑，其他支持文件可上传替换，删除需要当前指纹。skill在页面只读，在本地修改后刷新。冻结内部版本将完整资料包复制到snapshots；修改产生下一版草稿，已冻结快照保留。缺入口、缺引用或被修改的快照不能使用。第3步可加载已冻结版本，验证指纹并绑定题目；未冻结草稿不能执行。冻结版本不代表后续出题或评分完成。

旧项目可以继续查看和操作材料；首次按目录接收前，请编辑项目补充材料根目录。本地worker须运行：`bun run worker`，或使用`npm run start:iterm`同时启动前后端和worker。每次批量最多100条。

接收验证扩展名、大小及PDF头标识。PDF提取记录页码、提取方式与异常；DOCX/TXT/MD在入库时本地解析。原文件始终保持原样，原始文本作为受限产物保存于数据库。

单文件不超过30MB，一个材料包最多100份、合计100MB。相同文件名不会覆盖；上传使用幂等键防止同次请求重试创建重复工作流。换一个材料包再次上传相同文件允许保留独立记录。

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

`bun scripts/verify-input-versions.ts` 使用真实PostgreSQL临时schema及合成PDF测试并发导入、材料版本更新与晚到结果隔离，不调用识别服务。结果保存在 `docs/evidence/input-version-results.json`；这项验证不能代替真实PDF识别或浏览器目录选择验收。

`bun scripts/verify-project-folders.ts` 使用真实数据库临时schema与合成PDF验证项目文件夹入口、步骤就绪筛选、材料修改及逻辑删除，不调用模型。详情见[项目工作台验收](docs/evidence/project-folder-workbench.md)。

## 本地出题项目

每一期存于`projects/`独立文件夹。目录结构、文件说明和数据库职责见[项目目录说明](projects/README.md)；首期规则和skill见[第五期资料说明](projects/豆包高经济价值-第五期/README.md)。skill原文保留本地，数据库登记路径和版本指纹。

`bun scripts/verify-rule-versions.ts`用两个临时项目、真实PostgreSQL及本地文件验证规则编辑、并发冻结、历史快照、引用与指纹检查。`bun scripts/verify-codex-isolation.ts`只验证本机CLI沙箱的文件读写边界，不调用模型，不代表Codex执行器已经接通。结果及限制见[本地规则版本验收](docs/evidence/rule-workspace-verification.md)。

## Qwen 独立作答客户端

`server/answer-models/qwen.ts` 已提供纯文字作答客户端与安全错误分类，第五步页面配置、入队和答案结果入库/下载已接线，依赖第四步产物契约。服务端配置 `QWEN_API_KEY`（也可用 `DASHSCOPE_API_KEY`）、`QWEN_BASE_URL` 和 `QWEN_MODEL`；Key 与端点地域须匹配，Base URL 不包含 `/chat/completions`。模型与端点无默认值，思考参数支持范围以所选模型为准。

也支持通过 `OPEN_ROUTER_KEY` 调用 Qwen：仅配置普通 OpenRouter 调用密钥时，使用 `https://openrouter.ai/api/v1` 和 `qwen/qwen-plus`；可用 QWEN_BASE_URL/QWEN_MODEL 覆盖。管理密钥不能作答。不同端点只使用各自的密钥，不在失败后自动切换。

针对性测试：`bun test server/answer-models/qwen.test.ts`。真实冒烟：`bun scripts/verify-qwen.ts`，只发送合成文字材料，配置齐备时调用一次收费 API；缺配置退出码2。实现、证据及主流程接线边界见[Qwen 接入验收](docs/evidence/qwen-independent-integration.md)。

第五步与评分校验的产物格式、版本隔离及验收边界见 [输入与评分契约](docs/plans/2026-10-08-answer-input-and-score-contract.md)。`migrations/005_answer_queue.sql`补充第五步标记和队列索引；已通过项目迁移流程应用至当前配置数据库；其他部署按正常迁移流程应用。

## Codex 执行器当前状态

底层客户端已实现 ChatGPT 套餐登录检查、受限文件权限、结构化产物与事件记录、30 分钟超时和取消。真实 gpt-6.1-sol 调用通过；保留网络代理但不向子进程转发数据库或提供商密钥。skill 生成、出题和独立评分业务步骤仍待连接。最新功能边界见 [执行复盘](docs/reviews/2026-10-08-execution-review.md)。

第三步单题入口 `/api/workflows/:id/load-rules`，或在项目批量执行第 3 步；本地快照检查在事务内即时完成，不调用 Codex。验收见 [固定规则加载](docs/evidence/2026-10-08-rule-loading.md)。

## 第五步多供应商与执行器监控

第五步可选择 Qwen、Kimi、DeepSeek 或豆包，每次任务固定一个供应商和模型；配置及版本、完整答案、usage和安全错误沿用现有持久化队列。原生接口使用 `.env.example` 中各自的服务端密钥及显式模型ID，不会自动改走OpenRouter或切换模型。Kimi还支持MOONSHOT_API_KEY，豆包支持ARK_API_KEY。多模型同时作答、结果齐备判定尚未实现。

worker每5秒采样，系统可用内存估算低于 WORKER_MIN_AVAILABLE_PERCENT（默认10）时暂停领取新任务，恢复后继续；正在运行的任务继续。内存读取未知时明确标记unknown并沿用派发策略。`GET /api/monitor`读取本地安全快照，项目列表显示状态；超过30秒标为过期。API和worker须使用同一 STORAGE_DIR，仅支持一个本地worker。当前采集worker进程、数据库等待/运行任务和心跳；Codex子进程、认证及额度未接入采集。更新后需重启API和worker。

接线验收和边界见 [第四阶段接线验收](docs/evidence/phase-four-wiring.md)。

## 第六步独立评分

先保存第六步Codex模型与推理强度，再通过项目批量按钮或题目详情“独立评分”入队。`POST /api/workflows/:id/score`支持同一任务的wait_ms等待；worker单通道读取持久化任务，使用独立匿名输入目录与会话，不发送标答/目标分数/模型身份。报告逐条评分与程序校验结果保留，争议或无效评分显示失败，评分报告可下载；usage不换算为套餐单题价格。更新部署需运行迁移及重启API/worker。

`bun scripts/verify-answer-flow.ts`以临时PostgreSQL schema和注入模型验证；加`--real-score`只把首个评分任务改为一次真实Codex套餐调用，题目和作答仍为合成夹具。它不能证明真实材料八步闭环已完成。

## 单题生成数据清理

题目详情的“清理生成数据”保留题目、原件及第一步已入库文本，只清理脱敏及后续步骤的记录和产物；若PDF第一步尚未成功，则清掉失败提取尝试以便重试。运行中禁止清理。接口为 `DELETE /api/workflows/:id/generated`；现有删除题目接口仍是逻辑删除。真实题目1/3测试及删除验收见 [测试记录](docs/evidence/2026-10-08-real-question-folders.md)。

## 项目 skill 候选生成

资料与skill页可用显式Codex模型配置提交项目级生成任务，使用完整company-legal-task模板和固定本期资料；worker与独立评分共用一个Codex通道。任务、心跳、候选目录和问题清单持久化；候选不覆盖当前skill或已冻结版本。可用SKILL_BASE_TEMPLATE_DIR指定服务端基础模板目录。外部资格及平台当前规则未确认保留问题记录，内部必要规则缺失/冲突才阻断内部采用。通过检查的候选可在页面采用为新草稿，再通过既有冻结动作发布；历史版本与已绑定工作流保留。

## PDF提取与入库

PDF第一步使用智谱 `glm-ocr` 的版面解析接口，按返回页保存OCR文本、页码和问题记录，再把原文产物写入PostgreSQL；空页、乱码或接口返回的异常会记录下来，不因页级问题丢弃已返回内容。DOCX/TXT/MD由本地解析器读取后直接入库，不调用OCR服务。第二步由Codex读取数据库中的原文，按项目脱敏要求生成并另存脱敏文本。智谱请求和PDF工具等待上限为30分钟；文件大小限制由材料入口配置执行。识别结果仍需结合逐页问题记录复核，数据库入库不代表全文已核验。
