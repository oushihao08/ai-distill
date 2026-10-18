# 豆包材料独立材料库真实流程测试

## 按用户更新的实质内容验收标准调整（2026-10-18）

本节覆盖下文历史的“issues必须为零”口径。用户明确允许正常星号遮盖及不影响实质内容的差异；因此不再将OCR提示数量作为脱敏/建题的拒绝条件。预检仍拒绝无文件、无有效页数或整份无正文，保留空白页和全部issues；validation_report同时记录各文件原始提示及比较范围extracted_source_to_redacted_body。原件/正文摘要、页和字段覆盖、映射原文定位仍校验，不把OCR警告保留误报成原PDF全文识别准确。

178项材料库及下游回归、555条断言通过，bun run check通过。另更新一条过时的脱敏测试预期以匹配当前“截断批次立即拆分”的既有行为，未修改该算法。运行服务仍待无关出题attempt 22ea2062-8797-40ac-be89-631588110552终态后加载；未在它运行期间重启worker。

## 后续代码修复与小样本核查（2026-10-18）

从同源PDF的私有MinerU诊断原始块核实，56条unknown-type提示来自header/footer/page_number/aside_text等已知类型。解析器v3将这些类型保留为原文段落，不再误报；离线重放57页后剩37条问题（23无文字图片、9空块、5占位符），仍未放行。新增派发/执行前共用提取检查，让不合格输入在模型调用前返回明确错误，避免第四次任务式的付费调用结束后23514失败；加载和数据库质量门槛未放宽。

针对性检查31项、材料库与下游回归141项通过，完整`bun run check`通过。旧缓存测试将有识别问题的fixture称为健康缓存，与当前复识别行为不一致；本轮将健康fixture改为无issues，并单独验证有问题缓存复识别一次且保留源件和旧缓存，未回退process.ts的已有修改。

用户随后明确授权本链路后续必要模型/API调用及空闲时API/worker更新。期间检测到另一个真实出题attempt `e9d2ff15-f469-4e74-bff5-78ac1e33aafc`运行，故未重启worker。根据[MinerU官方接口参数](https://mineru.net/apiManage/docs)，只对第9页做`is_ocr=true`的独立小样本识别；仍返回`image_without_text`和`no_text_placeholder`，没有把该参数修改为全局默认，没有用小样本代替整份验收。私有原始响应保存在`.storage/verification/doubao-library-20261018/ocr-probe/`，不作为新题输入。

服务空闲后已加载新代码，真实提取任务`daf77d2e-2330-440c-b7bc-c6813f2a2940`于08:55:26Z成功，仍为57页37项问题。额外核对第17页原件：证件图像内存在正文，原提取仅52字符页边信息；pipeline强制OCR小样仍只有53字符。此证据反对直接忽略全部图片警告。两次隔离视觉补识别小样返回159/185字符，仅为后续修复方向证据，未发布到材料库、未改全局OCR配置。

本节是后续增量证据；下方前四次任务的原始事实保留。完整目标仍未验收完成。

2026-10-18，Asia/Shanghai。用户要求复制豆包项目，验证新材料库完整链路。操作仅通过本机HTTP API；未修改源项目、来源PDF或数据库表结构，未启动或重启服务。

## 固定范围

- 来源项目：豆包高经济价值 - 第五期（315407cd-43db-49d1-8eb3-c2dff77af859）。
- 测试项目：豆包高经济价值 - 新材料库全流程测试-20261018（d26d2953-0f32-440a-a328-377eee9e9182），material_backend=library_v1。
- 仅选题目2的一份原始PDF，10,438,259字节，SHA-256为8cd7d6aca9056ed3caf6b211274b65743f8efc34f1859e98590a56caaf401b48；未复制旧题面、标答、作答或评分。
- 材料包：d4353085-0921-4293-9ea4-f1f808ae91c4；文件版本：6458c800-d17e-4132-a789-9821494546ae。
- 复制项目Agent默认值、出题/评分配置、实际启用作答模型及50分上限、作答提示词和时长政策；共享原项目skill目录。回读出题/评分配置与来源一致。
- 来源步骤5残留provider=qwen、OpenRouter端点及qwen-plus，直接保存被当前接口400拒绝；测试副本改用来源项目实际启用的openrouter/qwen3.8-max-0902配置，保留提示词及时长政策。该配置保存成功不证明真实作答调用可用。

## 结果

| 环节 | 实际结果 |
| --- | --- |
| 创建新项目 | 成功，skill_exists=true |
| 上传/入库 | 成功，清单及原件摘要核验成功 |
| 提取 | 成功，57页，93条issues |
| 脱敏 | 失败，未发布可加载结果 |
| 项目加载 | HTTP409，尚无完整成功的脱敏结果 |
| 出题/作答/评分/达标/归档 | 未执行，不能宣称链路通过 |

入库任务660af73a-8fda-4a0a-9565-2d3ba0673905；提取任务b202e828-596e-4bc8-9089-20a7f2c3dc3f；首次脱敏任务2d897545-e54d-4b7e-9e9f-5d631feb995e。脱敏13:31:09开始，13:41:00结束，状态failed、error_code=api_queue_timeout。过程中检查点至少505个字段通过校验，但检查点不是完整脱敏结果。

## 首次尝试已证实问题

1. 日志4次call.failed/api_queue_timeout，各等待约45秒；当前API返回Agent=4、llmApi=8，活动与保存配置一致。只能证明等待本机API槽位超时，不能据此判定外部供应商限流或具体哪项任务占槽。
2. 同一次任务8次供应商调用出现HTTP200但incomplete_finish_reason，另有redaction_batch_budget_exceeded。两类model_api.call.failed/call.failed日志为同次调用的不同层记录，不能重复算16次。
3. runner.ts的usableDocuments要求document.issues.length===0且各页非空。本次93条issues由56条unsupported_block_type、23条image_without_text、9条block_without_text及5条no_text_placeholder组成。按当前源码，即使脱敏成功也将不可加载；该后续阻断是静态核对，本次实际首先失败于脱敏，并未发布usable=false结果。提示本身不证明正文失真，也不能把所有提示直接视为可忽略。

## 第二次脱敏重测

用户要求对同一材料再测一次。重测任务3163d593-650d-4286-ad7f-7dae3bea6059于13:45:38开始，13:54:45结束，状态failed、error_code=api_queue_timeout。运行中检查点最多记录497个已验证字段；这仍不是完整脱敏结果。日志记录4次api_queue_timeout（redaction-structured-6、-7、-8、-10）和10次唯一调用的incomplete_finish_reason；同一调用在model_api与业务层各有一条失败日志，不能按20次计数。最终查询材料包版本，redactions为空，证明没有发布可供加载的脱敏结果。

两次同材料尝试都以api_queue_timeout结束，且都遇到模型不完整返回。重测复现了失败，不构成成功验收；具体finish_reason仍未被普通日志记录，不能进一步断定是哪一种模型停止原因。

## 边界与恢复

本次重测没有调整并发、提示词、模型或放宽加载校验；没有创建第三次尝试。原项目和测试副本均保留。状态、配置回读、接口读取结果及安全日志摘录保存在.storage/verification/doubao-library-20261018/，只用于本次追踪，不能作为新题输入。

结论：真实PDF链路未通过；重测再次失败，当前不能认定所有项目可直接完整切换。需处理API排队预算、供应商不完整输出与重分批预算、提取issues的可用性判定后，再从明确的新尝试继续验收；本轮未验证后续出题、法律质量、交付文件或平台验收。

## 2026-10-18 后续根因核对

本轮继续前检查了仓库状态；存在大量其他未提交修改，均保留。未修改模型、提示词、并发或业务记录，也未发起第三次收费脱敏。

### 已核实的调用路径与差异

- `server/material-library/runner.ts` 的 `executeRedaction()` 调用公共 `redactExtractedMaterials()`，只从任务快照传入 `task_timeout_ms` 与 `request_timeout_ms`。其余参数继承当前公共默认值：每题并发8、模型槽位排队45秒、单请求上限180秒、单任务20分钟、输出上限16384 tokens。
- `server/llm-api/concurrency.ts` 的 `withModelApiSlot()` 在共享本机 SQLite 槽位取得 API 名额前计时；45秒内未取得名额会返回 `api_queue_timeout`，此错误表示本机槽位等待截止，不表示供应商拒绝。普通日志不记录哪个任务持有槽位，因此两次历史日志不足以确定当时的占槽者。
- 两次失败日志还分别记录了多次供应商 HTTP 200 后的 `incomplete_finish_reason`，用时约106–117秒。它与45秒的本机排队失败属于不同调用结果；现有安全日志不保存供应商的精确 `finish_reason`，不能断言具体是输出长度、过滤还是连接结束。
- 当前未提交源码差异把缺少 `finish_reason` 的不完整响应也改为立即缩批，并补有对应的合成测试。文件修改时间约14:39；第三次任务由14:40启动的 worker PID 10093 执行，事件中出现 `-a`／`-b` 拆批调用，证明该修订在真实调用路径运行。该次仍因请求预算耗尽失败，说明缩批逻辑单独不足以完成此文件。
- 两次脱敏任务都使用测试材料包冻结的 `siliconflow / deepseek-ai/DeepSeek-V4.1-Flash` 配置；本地系统设置仍报告 Agent 4、API 8。没有证据支持通过提高全局并发解决此问题。
- 提取结果仍有93条问题：56条 `unsupported_block_type`、23条 `image_without_text`、9条 `block_without_text`、5条 `no_text_placeholder`。当前 `usableDocuments()` 要求 issues 为空且每页有文本；不应把这些问题静默豁免或标记为可用。现有摘要文件只保留问题计数，不足以判断逐页缺失内容是否影响法律事实。

### 运行状态与验证

- 本次开始时 API PID 47713 已不监听 3700；只读健康请求曾成功，后续只读请求连接中断。未找到对应时段的 API 错误日志。按既有授权仅恢复 API：`bun server/index.ts`，没有重启 worker。
- 恢复后 `/api/health` 返回 database connected、schema ready；连续两次 `/api/monitor` 均返回活动工作流0、材料库 queued/running均为0，worker heartbeat 分别报告 PID 49441 和 10093（进程列表中两者均存在）。本轮启动的是 API 进程，未重启 worker。此状态证明查询时空闲，不证明更早调用期间的槽位占用。
- 针对性单测 `bun test server/materials/redaction-performance.test.ts server/llm-api/concurrency.test.ts`：48项通过。覆盖了不完整响应缺少结束原因时缩批、槽位排队截止、槽位释放和安全错误分类；不调用真实模型，不证明真实 PDF 脱敏质量或运行时槽位争用已解决。

### 当前阻断

材料库任务当前允许的并发为8，等于全局 API 槽位上限；历史记录确认至少有调用等待45秒未取得本机槽位，但日志未记录槽位持有者，无法把排队超时归因到某个特定外部任务。供应商多次返回不完整输出，第三次尝试又在有限请求预算内耗尽；完整脱敏结果尚未发布。继续需要调整方案或再做多次收费尝试，按授权边界先等待用户决定。尚未加载项目、创建题目或执行出题、作答、评分、达标、归档与导出。

## 2026-10-18 第三次脱敏尝试

按用户授权，仅新建一次同配置尝试。派发前只读确认 `/api/health` 为 schema ready、活动任务为0；当前共用处理配置与前次重试的模型、提示词摘要、20分钟任务预算和180秒请求预算完全相同。API 返回202，`request_key` 保存在 `.storage/verification/doubao-library-20261018/retry-3-request.json`，job 为 `6d91abeb-838a-426d-bff1-d1fc0bb95a9f`，前序失败任务为 `3163d593-650d-4286-ad7f-7dae3bea6059`。

job 于15:05:27（Asia/Shanghai）开始，15:10:18失败，`error_code=redaction_request_budget_exceeded`。按 `call_id` 去重后，安全日志显示10个 `incomplete_finish_reason` 和7个 `fetch_failed` 模型调用；另有并发子请求在首个失败收束时被取消。本次没有记录 `api_queue_timeout`，但这只说明该 job 的日志中未出现该错误，不能证明排队问题已普遍解决。代码已按不完整输出拆批运行，仍耗尽有限请求预算。检查点保留399个已校验字段，但材料版本 `redactions` 仍为空，没有可加载或可建题结果。

该重试不改共享并发、模型、提示词或预算，也未修改原PDF及豆包源项目。任务状态、调用错误分类和无发布结果已保存于 `.storage/verification/doubao-library-20261018/retry-3-status.ndjson`、`retry-3-response.json` 及普通日志。`GET /api/monitor` 回读显示材料库 queued/running 均为0。出题、作答、评分、达标、归档与导出仍未执行。

后续若要继续，需要针对模型不完整/网络失败与有限请求预算提出新的执行方案；模型、提示词或预算的任何调整，以及再进行多次收费尝试，须先取得用户决定。当前没有继续重试授权。

## 2026-10-18 问题修复后的继续测试

用户要求在其认为问题已解决后继续测试。先查询当前材料包，确认原版本仍无脱敏结果、前三次任务均失败；健康检查为schema ready、worker空闲。当前worker PID 55217于16:12启动，晚于脱敏执行源码16:09的修改时间，已加载该版本，无需重启。

### 定向测试

运行 `bun test server/materials/redaction-performance.test.ts server/materials/redaction-execution.test.ts server/materials/redaction-jobs.test.ts server/material-library/jobs.test.ts`：65项通过、0项失败、179个expect。该结果是合成测试证据，不证明真实模型质量或整条业务流程通过。

### 第四次真实脱敏尝试

确认本地API/worker无活动业务任务后，通过原HTTP API对同一隔离版本提交一次脱敏任务，未更改模型、提示词或共享并发。请求记录位于 `.storage/verification/doubao-library-20261018/retry-4-request.json`，job为 `f0cd3b65-583c-4787-b08f-022ca79d5bd8`。任务16:35:55开始，16:36:43失败，API状态为 `error_code=unknown`；状态回读保存于 `.storage/verification/doubao-library-20261018/retry-4-status.json`。

按job ID缩小到worker实例日志后，看到同一模型调用关联的3条 `redaction_source_not_found` 字段校验事件，随后提交记录PostgreSQL错误码 `23514` 及 `transaction.outcome_unknown`。不能从这些安全日志确认三个字段是否经后续补做修复。API终态及版本查询确认任务为failed，revision仍有0条脱敏结果，故未发布部分结果。

根因路径已由当前源码和迁移约束核实：`server/material-library/runner.ts` 只有在提取文档issues为空且每页正文非空时才设置 `usable_for_question=true`；当前提取仍有93条issues（56 unsupported_block_type、23 image_without_text、9 block_without_text、5 no_text_placeholder）。迁移042的成功任务约束要求恰有一个 `usable_for_question=true` 的脱敏结果，故本次提交被拒绝。该约束保护材料可用性；没有绕过它。字段源定位事件是另外一个待调查问题，不能与数据库约束失败合并成同一原因。

本次未加载项目、创建题目或执行作答、评分、达标、归档与导出。完整流程仍未通过；需先解决提取内容质量/问题判定与字段源定位反馈，再从已核实的API状态继续。追踪记录见 `执行观察/doubao-library-real-flow-20261018/总览.md`。本次未修改原项目、原始PDF、模型、提示词或全局并发。
