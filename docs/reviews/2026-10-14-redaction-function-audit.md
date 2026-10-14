# 脱敏业务逐函数审查与复判

审查日期：2026-10-14，Asia/Shanghai。对象：当前工作区源码，含尚未提交的改动。用途：让后续 AI 能按函数、证据和问题编号继续分析；本文不授权执行修改、重跑模型或改业务状态。

## 0. 结论与阅读规则

### 本轮执行计划与验收（2026-10-14，用户已要求制定并执行）

原审查是历史快照，以下执行记录单独维护；修改后旧函数行号和SHA不再代表当前源码。

任务清单：
1. 执行控制：修复失败排队统计、取消首因和墙钟/单调计时差异；验证暂停恢复后先检查截止时间，再接受返回或补位。
2. 文本正确性：原文定位优先精确匹配，禁止不同数字标点被合并；补齐明确规则的金额保留/编号遮罩；拒绝同页重复字段ID。
3. 失败恢复与速度：输出上限和批次估算分工明确；容量/格式错误尽早缩批；缺字段只补局部，单字段减少不必要的元数据往返；断点锁与部分文件清理修复。保持批次补位和全局请求有界，默认并发需有证据才调整。
4. 队列与真实验收：核查单题活动尝试、最终发布绑定、心跳与失败收尾；运行针对性后端回归；用HTTP API固定题目4和8验收，记录全部attempt、完成字段、调用数、重试、排队、墙钟和执行时间。核对服务归属后再加载改动，避免干扰其他任务。

设计选择：不采用仅加并发/加时限的参数修补，也不整模块重写；在现有执行器、共享客户端与队列契约内修复已确认路径。断点与最终事务保护继续复用；未证实的昂贵重构不进入本轮。

验收标准：
- 后端变更先有能暴露原缺陷的测试，再修复并运行相关回归；不运行前端测试。
- 模拟等待/取消/时钟差异/返回不完整时，停止原因可追踪；失败排队耗时不丢；已成功字段不重复请求。
- 定位不能把12-34、1234、12.34混作同值；项目明确保留金额时不得修改该金额；结构和页归属完整。
- 截断/缺字段不假成功；单字段仍须明确返回映射；重复字段ID在收费请求前拒绝；中断后已验证断点可恢复。
- 题目4和8以真实完整成功并发布当前绑定为准；核对字段覆盖、源结构与脱敏变化，定向审阅姓名/电话/编号/金额案例，报告覆盖范围，不承诺模型绝对零漏识别。
- 性能分别报告断点续跑与完整冷启动，不能拿续跑耗时冒充全量提速；目标全量10分钟内成功，未达到时继续依据阶段耗时定位，不延长超时凑成功。无法得到同输入成功基线时，不虚报提速比例。
- 来源原件、无关工作区改动和其他任务的进程不受本次操作影响；只停止本轮临时启动的进程。

当前执行记录（2026-10-14）：已实施 v17 局部修复；真实验收仍未完成。

| 事项 | 当前结果 |
| --- | --- |
| 回归用例 | 本轮新增先失败用例覆盖数字混淆、墙钟过期、失败排队统计、重复ID、输出上限、单字段补做、截断缩批、金额规则、取消首因、部分写入、规则变化；修复后通过。心跳增加定向测试。 |
| 运行检查 | `bun test` 运行6个相关文件：165 pass / 0 fail / 480 assertions；TypeScript `tsc --noEmit` 通过；指定修改文件 `git diff --check` 通过。上述不是真实模型验收。 |
| 正确性 | 精确匹配优先；有限中文逗号容错；编号缺省遮罩；金额明确保留表达；同页重复字段ID拒绝。 |
| 速度/恢复 | 完整有界输出容量；明确长度截断立即缩批；单字段修复减少字段编号回显；复用SQLite事务租约保护断点。v17旧断点隔离，后续须全量冷启动。 |
| 可靠性 | 双时钟截止校验、失败排队统计和取消原因；部分文件清理；当前配置发布前重验；活动输入冲突拒绝；心跳查询5秒时限并收束。 |
| 当前服务 | API PID34900、worker PID34830启动于08:32；只读监控当前无活动任务。尚未确认是否属于其他工作，已询问空闲重启以加载新代码，未擅自停止。 |
| 真实题目4/8 | 本轮尚未重派。当前API仍显示此前失败；没有新的成功耗时或提速比例。 |

审查纠正：当前 `createPool` 已有15秒 `connectionTimeoutMillis`，不能再称连接获取完全无界；本次增加的是心跳查询时限。客户端查询时限由本地 `pg/lib/client.js` 的 `config.query_timeout` 实现，类型包只在ClientConfig声明该字段，通过结构对象传入保留运行支持。

追加检查：再次只读查询确认 API PID34900、worker PID34830 仍存活；首次监控请求15秒观察超时，随后对同一服务重查成功且活动任务为空，未据此重启或重复派发。补充请求级墙钟截止测试（先失败后修复），确保整题未过期时也拒绝单请求过期返回；165项回归与类型检查通过。重启确认仍未收到，真实题目尚未重派。

阻塞核对：连续三轮均未收到既有服务重启确认。再次查到API PID34900、worker PID34830仍存活，监控返回running且活动任务为空；进程尚未确认归属，未重启、未重复派发。当前不能用这些旧进程证明v17真实运行，题目4／8完整成功、内容审阅和可信冷启动耗时仍缺失。目标标记blocked等待该决定，不标记完成。

待办：确认服务重启边界并加载v17；API派发题目4和8；记录冷启动真实请求次数、完整耗时与失败阶段；核对当前产物结构、金额与敏感片段；达不到完整成功和速度标准继续定位。源文件SHA和函数位置以下仍是审查时快照，不伪装成修改后的源码。F01/F21涉及模型识别质量与全文一致性，本轮先保留明确证明边界并做实际内容核对，不通过放宽校验或引入庞大全局实体系统来消除失败。

**真实题目8仍失败，整体“准确且快速完成脱敏”的目标未验收。代码有值得保留的基础，但当前执行控制、输出预算、文本定位和诊断统计存在实质缺口。不能把全部问题归咎于模型，也不能仅靠加并发解决。**

- 值得保留：模型只识别敏感片段；程序生成正文；附件/页/结构由来源恢复；输入冻结；发布前事务检查；字段级断点；有界请求。
- 需要重点复判：忽略标点后的全量匹配、输出估算、“整题20分钟”边界、多层计时与原因丢失、8路默认并发、多任务排队、心跳失联后的行为。
- 尚未查明：题目8最后超时是否受休眠、时钟变化、事件循环停顿、网络或其他本地异常影响；不能把下述静态缺陷直接写成这次失败的根因。
- 没有发现值得把整个模块无条件删除重写的证据。函数大多数有业务用途；问题主要在组合与契约，而非函数数量。

证据标签：`S`=本次阅读源码确认；`H`=先前真实运行记录、此次未重跑；`L`=本次重读日志；`R`=由源码推导出的条件风险，尚未运行复现；`U`=未知。`P1`=可能导致错改/漏脱敏、长等待、错误发布或主要验收失败；`P2`=可靠性/诊断/维护问题；`P3`=局部冗余。优先级不表示题目8根因已确认。

复判结果遵循 rejudge：保留／修改后保留／剔除／待核实。函数标为“修改后保留”表示职责有用但实现或边界需修正；不是已经修改。收益、风险及其影响分别在函数表与 F 问题记录中说明。

任务清单与本次完成标准：阅读五个直接模块的全部函数；追踪共享请求、槽位、任务取消及发布链；登记每个命名函数和匿名回调；每项问题给出位置、触发条件、影响、反证/限制与待验证点；产出单份分析文档。全文源码阅读、AST 函数清单和调用检索是本次证据；没有运行测试、启动服务、调用真实模型或改业务代码。

## 1. 范围与执行链

直接模块：`server/materials/redaction.ts`、`redaction-jobs.ts`、`redaction-config.ts`、`redaction-execution.ts`、`server/llm-api/concurrency.ts`。此前统计为业务747行，包含注释空行，不含共享客户端等依赖。

完整逐函数扩查：`server/llm-api/client.ts`、`server/concurrency.ts`、`server/task-signal.ts`、`server/materials/state.ts`、`server/external-call.ts`、`server/worker-pool.ts`。辅助阅读：`server/worker.ts` 的派发/退出、`llm-api/config.ts` 的参数/端点/凭证校验、`shared/step-registry.ts` 默认规则、相关测试与模块文档。这些辅助文件未宣称逐函数全审。

CodeGraph 状态调用返回 Transport closed，未初始化索引；使用当前源码、rg 和 TypeScript AST 建清单。末尾函数清单保存源码摘要和函数位置，后续代码变化时以摘要判断本文是否过时。

```text
HTTP 单步/批量派发 → enqueueRedaction
  → 锁工作流/前置状态 → 当前提取产物 → 冻结来源、模型、规则、执行预算
worker 的 API 任务池 → runNextRedaction
  → 失联恢复/领取 → 取消监听 + 心跳 → readSource 验证数据库正文哈希
  → redactExtractedMaterials → redactStructuredMaterials
    → 原结构转 targets/wire_id → 加载断点 → 有界打包
    → 题内 worker 池 → processBatch → runExternalCall
      → createModelApiClient.complete 外层计时 → withModelApiSlot
      → SQLite 全局槽位 → 内层 complete 计时 → fetch/JSON/完整返回校验
    → 每字段定位/遮盖/金额校验 → 单写入链保存断点
    → 全字段重组校验 → 渲染正文与结构索引
  → 写本地文件 → DB事务锁/输入再次校验 → 发布 artifacts/成功状态
  → 成功后清理断点；失败保存安全原因及进度
```

三种并发不可混为一谈：worker池控制正在执行的业务任务数；题内池控制该题准备调用的批次；全局槽位控制本机实际模型请求。题内 `active_requests` 包含排队，不能直接当作供应商正在执行数。

## 2. 问题记录：机制、收益与风险

### F01 · P1 · 结构完整不能证明脱敏识别完整（S）

位置：redaction.ts:238、285、249–254。`redactions:[]` 被视为已处理字段；没有独立证据判定敏感信息是否漏识别。收益：明确空数组可区分缺字段，并保留非敏感原文。风险：模型漏识别但返回合法空数组，仍可全题成功，可能泄露敏感值。决定：**修改后保留覆盖与定位校验；“可保证完整脱敏”这一结论剔除**。未知：真实材料的漏识别率及误改率。不能以增加通用正则就宣称全部解决。

### F02 · P1 · 定位容忍过宽，可能遮盖不同实体或相邻非敏感值（S/R）

位置：redaction.ts:153–175、203–225。匹配前删除标点/空白并做 NFKC；所有匹配位置都应用遮盖，无上下文或边界。合成推导例：`12-34`、`1234`、`12.34` 都规范化为 `1234`；原字段同时包含这几种值时，模型只标一种，程序也可能改其他位置。收益：修复 OCR 空白/标点差异，减少无效失败。风险：编号、金额、小数或不同名称误合并；影响原文准确性。决定：**修改后保留定位职责；匹配宽容边界待核实**。这是代码可推导风险，未证明题目8实际发生此类错改。

### F03 · P1 · “最坏输出估算”不是真正上界（S/R）

位置：redaction.ts:344、356、359、388；redaction-execution.ts:19。估算按每字段一项映射重复完整原文；真实输出可能含很多短敏感值，每项都重复 JSON 键、kind、mask_text，固定开销可能更大。ASCII按4字符/token也不是严格上界。补做时额外 system 反馈未计入输入预算。收益：相较只数32字段，能按负载减少请求。风险：估算既可能过高拒绝，也可能过低分配 max_tokens，导致截断、重试和更慢。决定：**修改后保留预算打包；剔除“保守估算一定装得下”的保证**。具体模型 tokenizer/输出分布未实测。

### F04 · P1 · 超长单字段没有可用的拆分恢复路径（S/H）

位置：redaction.ts:356–357、429–435。输出估算超限且上限≥1024时允许完整发送，但输入字符/token超限仍直接失败；拆分只按字段数分，不拆单字段。收益：不截断、不猜测，安全失败。风险：一段长材料阻断整题；放开输出预检查只解决初始入口，不能保证实际输出完整。决定：**修改后保留完整输入与输出校验；单字段处理能力仍缺失**。切分必须证明跨边界敏感值、原始位置及合并完整性，不能随意按字符切。

### F05 · P1 · 补做有界，但对不同故障采用近似同一策略（S）

位置：redaction.ts:370–435。可解析的部分成功只补失败字段，是有效设计；无法解析或 finish_reason 不完整时先重复当前批，第二次才可能拆分；≤8个剩余字段不会进一步逐字段隔离；同根请求预算6次、全题默认2×初始批数+4次。收益：避免无限收费和整题重做。风险：明知容量不足仍同样重发；少量顽固字段使所有剩余批次取消；递归左半可先耗尽共同预算。决定：**修改后保留有界局部恢复；不采用“继续加重试就能修好”**。`index` 参数未使用，可剔除；不是主要性能根因。

### F06 · P2 · 补做反馈丢失多字段原因，ID空间还可能不一致（S）

位置：redaction.ts:43、409–424。每个失败字段覆盖同一个 `failure`，反馈通常只剩最后一个错误；source_not_found 包含原结构 target_id（如 b…），请求却使用 wire_id（f…）。收益：只发安全字段而不泄露正文。风险：反馈与本轮目标不对应或缺少其他失败原因，降低补做有效性。决定：**修改后保留安全反馈，需明确按 wire_id 归属的有限错误集合**。它是否实际造成模型漏回尚未知。

### F07 · P1 · 任务并发与请求并发叠加，8路变更没有实跑依据（S/R/H）

位置：worker.ts:108、redaction.ts:440、redaction-execution.ts:10、llm-api/concurrency.ts:9。默认8个业务任务均可再开8个批次，最多64个批次竞争全局默认8个请求槽位；45秒队列时限可能先使等待者失败。槽位按轮询抢占，无FIFO公平队列。收益：单题可能利用空闲容量。风险：多题排队、抢占及尾延迟增加；单题快不等于总吞吐好。决定：**8路默认值待核实；保留全局槽位限制**。此外 `configuredLimit` 允许环境值到32，保存设置接口才限制API≤8，所以“任何配置全局都硬限8”不成立；无需读取真实环境值即可确认这条代码边界。

### F08 · P1 · 多层截止时间和取消原因传播难以归因（S/R）

位置：redaction.ts:300–303、378–388；client.ts:169–179、229–238；slot.ts:11–19；task-signal.ts:31。整题、停滞、每请求、客户端外层、客户端内层、排队各有计时；若几个计时同时到期，日志可能分别显示 caller_cancelled、local_deadline、redaction_request_timeout。共享客户端与取消 watcher 不保留上游 reason。收益：局部调用能及时停止等待。风险：首因和被连带取消者混淆；加并发或加超时可能针对错因。决定：**修改后保留截止时间，但当前原因链不充分**。最后四个请求同时失败不能证明四次独立模型超时。

### F09 · P1 · 整题时限不是端到端墙钟保证（S/R/U）

位置：redaction.ts:273–303、450–466；jobs.ts:124–187；task-signal.ts:16。预算计时在来源结构展开后开始；此前DB加载、之后渲染、文件写入、DB提交不受这个任务timer覆盖。guard只看abort状态，不检查当前时刻；同步长操作会延迟timer。DB连接等待/多数SQL没有本函数独立时限。收益：模型执行阶段有预算。风险：仍可在输入、持久化或暂停恢复后等待很久。决定：**修改后保留局部时限；剔除“整条业务一定20分钟结束”说法**。运行时休眠/时钟变化影响未确认；不要凭计时差异直接认定某一种。

### F10 · P1/P2 · 排队、请求和最后进度统计不完整（S）

位置：redaction.ts:393–399；client.ts:236–237；jobs.ts:181。只在成功completion上累加queue_wait_ms；失败调用即使排队很久也未附带已知排队耗时，整个耗时被算入request_duration_ms。active_requests包含等待槽位。失败时last_progress_at改成失败时间，覆盖“最后新增字段”的语义。收益：已有计数可观察推进。风险：错误判断槽位空闲/供应商慢，并据此调并发；误判进度停滞。决定：**修改后保留统计，之前“110毫秒证明排队没有问题”的推论剔除**。

### F11 · P1 · 断点锁回收有并发与崩溃边界风险（S/R）

位置：redaction.ts:94–113。wx新建锁可避免正常重复持有；回收时读token再unlink不是原子CAS。两个回收者可都读到旧token，其中一方重建锁后另一方删掉新锁。崩溃若留下半写JSON，直接busy；PID被复用且活着时旧锁也一直busy。收益：保护正常单机断点写入。风险：丢互斥、互相覆盖或永久阻塞。决定：**修改后保留独占机制；竞争与崩溃场景待复现**。当前单进程正常占锁测试不覆盖这些交错。

### F12 · P1 · 原结构字段唯一性在该入口没有校验（S/R）

位置：redaction.ts:127、140、306、238；jobs.ts:95。readSource只验页序/text，没有深验structure；同页重复block.id会使setters和checkpoint key覆盖，而wire_id仍不同。收益：生产MinerU生成唯一id，正常来源可用；跨页同名已有测试。风险：异常/兼容来源的同页重名造成字段覆盖、进度少算或重组错误。决定：**修改后保留来源投影；需确认所有上游能否保证同页唯一，再决定校验位置**。不能把这一风险写成当前MinerU必然生成坏ID。

### F13 · P1 · 同工作流多活动尝试的防线不完整（S/R）

位置：jobs.ts:71–79、108–113、168–175。active只拒绝另一执行位置；同位置但不同digest/config可新建waiting并保留旧running。成功提交只验自己的running与来源digest，不验当前配置/最新尝试；失联恢复也直接改steps。普通材料/设置修改经state.ts会先取消旧尝试，这是有效防线。收益：正常路由冻结和事务保护。风险：环境默认配置变化或其他未走失效入口的配置/来源变化下，可能并存尝试并竞争当前步骤状态。决定：**待核实实际可达入口；局部队列契约确有缺口**。不宣称普通设置接口已越过state.ts。

### F14 · P2 · 部分产物写入失败后可能留下孤儿文件（S/R）

位置：jobs.ts:156–159、184。wrote在两个文件全部写完后才为true；第一个成功、第二个失败时不会进入清理。收益：wx避免覆盖，数据库未成功时不发布。风险：私有磁盘残留、重试目录维护成本；不是错误发布。决定：**修改后保留先落盘再事务发布；清理条件需覆盖部分写入**。

### F15 · P1/P2 · 心跳和失败收尾缺少完整的等待边界（S/R）

位置：jobs.ts:124、185–187。heartbeatInFlight防重叠正确，但一个DB查询悬挂会阻止后续心跳；任务仍继续收费。失败pool.connect在内层try外，取连接失败会丢失本次落库收尾；finally只停interval，没有等待已经在途的heartbeat。收益：正常运行能保存安全进度，避免心跳堆积。风险：失联恢复误判仍运行工作、失败状态不及时保存、退出难结束。决定：**修改后保留心跳/收尾；DB异常验收缺失**。取消轮询2秒服务端statement_timeout不覆盖pool.connect及所有事务命令。

### F16 · P2 · 断点与用量有重复全量成本，但未证明是实际瓶颈（S/U）

位置：redaction.ts:80、87、312、466、68。每次提交拷贝Map并重写全量JSON；结尾重算整个checkpointId；稳定序列化逻辑在config与executor重复；任一调用usage未知导致整个aggregateUsage返回null。收益：简单原子快照、配置身份稳定、不会把未知费用记成0。代价：大任务累计复制/序列化，成功用量也无法单独保留。决定：**修改后保留统计表达；性能重构待测量**。此前进度记录显示保存/校验很小，但不能据此断言所有本地开销都小：打包、结构展开、重组、DB和暂停未都算入这两项。

### F17 · P1 · 部分脱敏规则与程序遮罩策略不一致（S/R）

位置：shared/step-registry.ts:23–34；redaction.ts:179–201、280、229。默认规则要求编号首2/末2保留，缺mask_text的identifier却全遮盖；name/phone由硬编码策略覆盖模型选择，无法支持任意项目遮罩规则。金额保护开关靠提示词正则，合成句“金额不得脱敏”不触发；金额匹配也不覆盖中文金额、其他币种及表格单位继承。收益：姓名/电话确定性遮盖、常见金额检查。风险：结果可定位且校验成功，但未满足实际业务保留规则。决定：**修改后保留确定性生成；规则契约不足必须明确**。不能把配置提示词允许自由写等同于程序支持所有规则。

### F18 · P2 · 返回部分映射后“整批重试”的描述需要区分（S）

位置：redaction.ts:403–425；client.ts:58。可解析且finish_reason为stop时通过字段可立即保存；finish_reason不完整被客户端提前拒绝，业务无法从原始响应救出已完整字段。收益：拒绝未完成回复，防止假成功。代价：不完整响应中有效部分也需再次调用。决定：**保留拒绝不完整结果；部分救援能力待设计**。不能通过直接接受截断JSON或假补空数组来“提速”。

### F19 · P2/P3 · 无用参数、不可达生产清理与文档漂移（S）

位置：collectStructuredTargets的includeEmpty未有true调用；processBatch.index从未读；closeModelApiSlots无生产调用；README同时残留4路与8路描述；Agent分支仍30分钟且无同等API字段断点。收益：历史兼容及测试/清理入口仍可能有用。代价：维护者误判能力和默认边界。决定：**剔除明确未用参数的必要性主张；保留清理入口但待接入；文档修改后保留**。Agent分支是兼容行为，不是这次API题目8失败原因。

### F20 · P1 · 测试与实际供应商/完整业务链的差距（S/H）

位置：redaction-performance.test.ts:6–11、24；redaction-jobs.test.ts:10–30；client.ts:229–230。合成替身主要返回空映射、固定延时；SQL替身按前缀响应，不模拟真实锁、失联和提交未知；注入HTTP时绕过生产槽位。收益：定位局部回归、取消及恢复路径。风险：默认8路峰值断言只证实调度数字，不能证明真实吞吐/公平；空映射保原文不证明敏感信息识别。决定：**保留有意义的行为测试；以41项通过证明整体成功的结论剔除**。

### F21 · P1 · 跨字段/批次的同主体遮罩一致性没有独立保证（S/R）

位置：shared/step-registry.ts:23；redaction.ts:186、238、377、413。默认规则要求同主体全文一致，但每批模型只见本批targets；程序按各字段各自kind/mask_text遮盖，没有跨字段映射一致性核对。合成推导例：两个字段均含“甲公司”，一项mask_text为“甲”，另一项为“甲公司”，都会通过定位，却生成不同遮罩。收益：字段独立、可并发且容易恢复；name/phone硬编码提供部分一致性。风险：主体在不同附件/字段的遮盖形式不一致，或同实体一处识别一处遗漏；影响案件可读性与脱敏完整性。决定：**修改后保留并发与原文生成；全文一致性的保证待核实**。这不等于必须引入复杂全局实体系统，需要先界定项目实际一致性要求。

## 3. 直接模块逐命名函数复判

表中“价值”说明是否必要与正收益；“风险”引用 F 编号，包含触发与影响；没有发现问题不等于运行已验收。ID采用文件前缀+当前行号，匿名控制回调见第5节和末尾AST清单。

### 3.1 R = server/materials/redaction.ts

| ID/函数 | 用途与调用关系 | 价值/必要性 | 风险及影响 | 复判 |
|---|---|---|---|---|
| R032 outputError | 创建安全错误并写校验失败日志；各校验器调用 | 必要；统一原因码且不打印正文 | 每字段缺失都会error日志，噪声与业务失败混淆；expected等任意details由内部调用约束 | 修改后保留，P2 |
| R036 errorReason | 只认可可补做的输出错误原因 | 必要；认证/配置错误不重复收费 | 输出故障粒度不足，F05 | 修改后保留 |
| R040 isRetryableNetworkError | 允许一次声明可重试的network错误 | 有用；有限恢复瞬时断网 | 中断发生时供应商可能已执行；重试不具幂等，收费风险 | 保留边界，实际重试效果待核实 |
| R043 structuredRetryFeedback | 把安全ID/数量转补做system反馈 | 有用；反馈不含原文/供应商错误 | F06；只剩最后错误和两种ID空间 | 修改后保留 |
| R050 parseStructuredResponse | 去完整代码围栏并JSON.parse | 必要；兼容格式不降低内容检查 | 失败返回不保留安全结构摘要，难区分截断/无效JSON；F18 | 保留，诊断待补 |
| R054 withCallMetadata | 将一次调用关联/用量/耗时附在error | 必要；失败不能记零耗时 | 原地修改Error，调用者需知道属性覆盖；F08/F10 | 修改后保留 |
| R058 withCallHistory | 失败时附全部调用ID与累计耗时/用量 | 有用；可核对收费与补做 | sum是并行请求累计耗时，不是用户等待时间；F16 | 修改后保留 |
| R063 isRecord | 判断非空非数组object | 必要；轻量运行时形状判断 | 不等于普通JSON对象；当前来源JSON基本符合边界 | 保留 |
| R064 stableJson | 为摘要稳定序列化config/source | 必要；键顺序不改变身份 | 全量计算及重复实现；F16 | 保留，不优先重构 |
| R065 normalize | stableJson递归排序/去undefined | 必要内部递归 | 非JSON对象、循环输入不支持；调用方应保证JSON来源 | 保留 |
| R068 aggregateUsage | 汇总各调用用量 | 有用；合计用量与调用结果关联 | 任一null使全部null，已知部分丢失；F16 | 修改后保留 |
| R070 merge | 数值求和、对象取公共键、相同值保留 | 有用内部归并 | 供应商字段不一致时信息被丢弃；不应误称完整账单 | 修改后保留 |
| R080 structuredCheckpointId | 材料/原文targets/config/协议hash | 必要；避免跨输入恢复旧映射 | 大对象重复计算；不把速度参数加入语义身份是合理设计，F16 | 保留 |
| R083 structuredFieldKey | material/page/target三元组作为断点键 | 必要；防跨页串字段 | 同页ID重复仍碰撞；F12 | 修改后保留输入不变量 |
| R087 saveStructuredCheckpoint | 私有临时文件wx写入，再rename原子替换 | 必要；未落盘不推进进度 | 写操作未完整包在cleanup范围；磁盘故障可能残留tmp；无fsync，不承诺断电持久性 | 修改后保留 |
| R094 ownCheckpoint | wx锁文件；死进程回收；返回解锁闭包 | 必要；避免并发断点写入 | F11，PID/损坏锁/非原子回收 | 修改后保留 |
| R127 collectStructuredTargets | 将段落、列表项、表格单元格、图注/脚注变字段 | 必要；保持本地结构和页归属 | F12；includeEmpty参数未使用；超长字段F04 | 修改后保留；未用参数可剔除 |
| R140 createTargetSetters | 为每结构字段创建原位写回函数 | 必要；不让模型重写结构 | 同页同ID覆盖、数组索引依赖来源不变，F12 | 修改后保留 |
| R153 normalizeMappedText | NFKC、去标点空白、保留原偏移映射 | 有益于OCR容错 | F02；所有标点等价过宽，编号意义被消去 | 修改后保留 |
| R162 findMappedSpans | 返回字段中敏感值的全部匹配范围 | 必要；按原文偏移修改 | F02；重复归一化、朴素O(n×m)；实际CPU成本未知 | 修改后保留 |
| R177 starMask | 按Unicode码点生成星号串 | 必要小工具 | 遮罩长度不等于UTF16长度是预期；不是保长度协议 | 保留 |
| R179 maskName | 常见复姓/首字保留，其余固定** | 有用确定性姓名遮罩 | 不是完整姓氏识别器；输入带标签/少数民族/外文时不符合规则，F17 | 修改后保留 |
| R180 maskPhone | 数字前3后2保留，其余数字星号 | 有用确定性电话遮罩 | 区号/分机/国际码策略固定；项目自定义不一定一致，F17 | 修改后保留 |
| R186 replacementFor | 根据kind/mask_text决定具体遮盖范围 | 必要业务规则中心 | 模型mask_text可重复/只遮很小部分；硬编码策略与提示词冲突；跨字段不一致，F02/F17/F21 | 修改后保留 |
| R203 applyStructuredRedactions | 找全部span，合并重叠并从后往前替换 | 必要；避免偏移移位和重复遮盖 | F02；重叠并集可能遮掉本应保留部分；误识别不能靠此纠正 | 修改后保留 |
| R229 assertAmountsPreserved | 数字金额字符串的出现次数不得减少 | 有用针对已声明保留金额 | F17；覆盖范围有限，不识别中文/币种/表格单位；编号与金额冲突需规则判定 | 修改后保留 |
| R238 validateStructuredOutput | 解析fields、覆盖检查、遮罩写回和结构重建 | 必要；拒绝无法定位/缺字段 | F01/F12/F17/F21；未知项忽略和重复合并是既定契约，不能误判成必然漏洞 | 修改后保留 |
| R271 renderMaterialPages | 按原页生成内部页分隔正文 | 有用；下游可定位来源页 | 内部分隔符与原文同字面时有歧义；目前索引仍提供结构归属 | 保留 |
| R273 redactStructuredMaterials | 编排模型协议、打包、请求、断点、校验、渲染 | 必要入口；职责过度集中 | F03–F19汇集；约195行压缩编排难审计，多状态跨闭包共享 | 修改后保留；不以拆文件本身充当修复 |
| R290 validate | 绑定本题source/金额策略给Agent校验 | 必要薄适配 | F01/F17从底层继承 | 保留 |
| R297 stopError | 创建有原因码且不可重试的停止错误 | 必要；终止原因标准化 | 后续层未总保留reason；F08 | 修改后保留 |
| R298 cancel | 上游取消转本执行器停止 | 必要 | 上游取消原因被统一为cancelled；F08 | 修改后保留 |
| R303 guard | 在阶段边界拒绝已abort任务 | 必要；防迟到提交 | 不主动核对绝对/单调deadline，只等timer触发；F09 | 修改后保留 |
| R308 notify | 计算elapsed并发布进度快照 | 必要；UI/心跳读取 | active含排队、elapsed口径、onProgress异常可终止执行；F09/F10 | 修改后保留 |
| R312 commitFields | 串行写链保存Map快照，落盘后再记完成 | 必要且有价值；避免互相覆盖 | F16；写失败使后续链全部失败，是安全关闭而非独立恢复 | 保留核心设计 |
| R343 wireTargets | 从batch恢复发给模型的f编号/text | 必要；模型不处理私有页/附件元数据 | 每次candidate重展开既有批次，打包重复计算，成本未测 | 保留 |
| R344 outputEstimate | 估算fields JSON并留25%+64余量 | 用途必要，实现依据不足 | F03；不是最坏情况上界 | 修改后保留 |
| R348 flush | 把已填批次入队并清空打包状态 | 必要小闭包 | 准确性依赖count/pages一致；源码未发现单独丢字段路径 | 保留 |
| R370 processBatch | 一次调用+有限修复，失败时有界二分 | 必要核心调度 | F05/F06/F08；index未用；分支状态较难维护 | 修改后保留 |
| R378 abort | 整题abort传给当前callController | 必要；多批统一收束 | 共享客户端后续可能丢reason，F08 | 修改后保留 |
| R385 aborted | call被停止时结束本地等待Promise | 必要；不合作替身也有界返回 | 底层仍可能在执行/收费；本地结束不证明远端停止，F08 | 修改后保留诊断边界 |
| R454 validate（属性） | Agent调用回调转R290校验 | 必要回调适配但可直接引用 | 无独立业务价值；多余lambda属P3 | 可剔除包装，保留校验 |
| R469 redactExtractedMaterials | 对外入口，兼容旧Codex参数并检查prompt | 必要；生产队列/测试公共入口 | 不独立完整校验材料/config，依赖队列；F12 | 保留入口并明确调用契约 |

### 3.2 J = server/materials/redaction-jobs.ts

| ID/函数 | 用途与调用关系 | 价值/必要性 | 风险及影响 | 复判 |
|---|---|---|---|---|
| J022 hash | SHA256正文/产物 | 必要；完整性校验 | 不证明识别内容正确 | 保留 |
| J023 redactionFailureSummary | 安全提取原因码/调用ID/数量/用量/耗时 | 必要；数据库错误不泄露正文 | 未带target_id/全部缺失ID、queue等待；UUID正则仅粗验，F06/F10 | 修改后保留 |
| J037 digestMaterials | 摘出来源标识与产物哈希 | 必要；去掉非语义展示字段 | 输入顺序参与摘要；与来源排序契约必须一致 | 保留 |
| J038 redactionInputDigest | 对来源集合计算冻结摘要 | 必要；队列和DOCX导出共用 | 不能随意改算法破坏历史成功绑定 | 保留 |
| J039 matchingRedactionDigest | 当前来源与任务摘要相等 | 必要；拒绝过期材料 | malformed数组可能抛异常，由任务处理；不核对模型配置，F13 | 保留 |
| J042 currentRedactionExecutionConfig | 读取项目9步骤设置、合并默认并加协议 | 必要；远程操作/入队同来源 | 环境默认变化不等于项目配置失效事务，F13 | 修改后保留 |
| J048 currentSources | 取每附件最新成功提取、核总数、按manifest排原附件序 | 必要；不是只看文件夹数 | 多次SQL依赖调用方事务；pool调用时非同一快照，最终再校验缓解；F09/F13 | 保留并明确快照边界 |
| J060 enqueueRedaction | 锁题/前置检查、复用相同任务、冻结新尝试并失效下游 | 必要；避免正常重复派发 | F13；same-target不同输入活动尝试未在本函数终止；复用未比较execution预算，属既定语义需说明 | 修改后保留 |
| J088 readSource | DB正文/来源哈希/页序校验，返回材料 | 必要；不信storage_path文件绕过DB | F12；JOIN attempt未过滤succeeded但currentSources先选成功；结构深校验依赖上游 | 修改后保留 |
| J103 runNextRedaction | 失联恢复、领取、执行、发布、失败持久化 | 必要；完整业务边界 | F09/F13/F14/F15，约86行极密集含事务/文件/模型三类副作用 | 修改后保留 |
| J143 onProgress | 把内存安全进度交给heartbeat | 必要薄适配 | 直到下一次heartbeat才落库；终态走独立持久化 | 保留 |
| J144 execute | 给Agent调用加call_id/外部日志/30分钟封顶 | 有用兼容Agent | 与API运行预算不同，F19 | 保留并说明差异 |
| J145 executeApi | 给模型API加call_id/外部日志/外层上限 | 必要；关联attempt和外部调用 | call_id由此重新生成，preassigned ID与实际ID需按返回/error一致；F08/F10 | 修改后保留 |

### 3.3 C = server/materials/redaction-config.ts

| ID/函数 | 用途与调用关系 | 价值/必要性 | 风险及影响 | 复判 |
|---|---|---|---|---|
| C011 stableJson | 配置相等比较的稳定序列化 | 有用；避免键顺序误失效 | 与R064重复，成本小；F16 | 保留，不为去重重构 |
| C012 normalize | 递归规范化配置 | 必要内部函数 | JSON对象契约；循环/非JSON输入未支持 | 保留 |
| C016 sameRedactionConfig | 比较有效配置，异常视为不同 | 必要；设置保存/恢复默认决定失效 | 默认来源变化影响比较；异常false安全但诊断有限 | 保留 |
| C020 mergeRedactionDefaults | 区分历史Codex配置与API默认 | 必要历史兼容 | 默认API配置解析失败时暂不放api，后续validate再报；不是运行换模型 | 保留 |
| C029 validateRedactionConfig | 白名单字段、prompt长度、模型/API配置校验 | 必要边界 | 只验配置形状，不保证当前凭证可用或规则语义可执行；F17 | 保留并声明证明范围 |

### 3.4 E = redaction-execution.ts；S = llm-api/concurrency.ts

| ID/函数 | 用途与调用关系 | 价值/必要性 | 风险及影响 | 复判 |
|---|---|---|---|---|
| E011 resolveRedactionExecution | 合并预算默认并校验正整数/并发/字段上限 | 必要；冻结可解释预算 | 默认8未经真实验收；时限相互关系未校验；用户不能从步骤设置调整这些值，F07/F09 | 修改后保留 |
| E019 estimateRedactionTokens | 中文/ASCII启发式估token | 有用低成本打包 | 不是模型tokenizer，不是安全上界；F03 | 修改后保留其启发式定位 |
| S006 gateRoot | API槽位独立命名空间，不与Agent争用 | 必要；复用实现但隔离业务 | SQLite目录名仍叫agent-slots易读错，无实质冲突 | 保留 |
| S007 withModelApiSlot | 获取全局API槽位、队列超时/取消、执行后释放 | 必要；限制真实HTTP并发 | F07/F08/F10；每请求读取配置开SQLite；queue错误不带已等待毫秒 | 修改后保留 |
| S011 cancel | 上游取消转槽位等待取消 | 必要 | 不传reason；F08 | 修改后保留 |
| S023 closeModelApiSlots | 关闭API槽位实例 | 有用资源生命周期接口 | 生产worker未调用；不能凭函数存在宣称已清理，F19 | 保留接口，生产接入待核实 |

## 4. 关键共享依赖逐命名函数复判

以下函数也完整阅读。价值/风险按脱敏调用链限定，不外推为整个客户端或Agent系统验收。

### 4.1 L = server/llm-api/client.ts

| ID/函数 | 用途与价值 | 具体风险/影响 | 复判 |
|---|---|---|---|
| L010 record | 判断普通object形状，必要 | 与L073重复但低成本 | 保留 |
| L011 onlyFields | 拒绝未知输入字段，必要接口边界 | 对普通JSON配置有效，不证明供应商支持该参数 | 保留 |
| L012 networkFailureReason | 将嵌套网络错误映射安全原因 | 不泄露原始错误；未知统一fetch_failed降低诊断粒度 | 保留 |
| L031 requestId | 只保留UUID供应商请求ID | 非UUID实际ID丢失，诊断能力降低；安全取舍 | 修改后保留 |
| L035 generationId | 从白名单header取gen标识 | 错误没有header时无ID，不能据此声称远端未执行 | 保留 |
| L039 providerError | HTTP/已知错误码分类，必要 | OpenRouter主要按status；200且error形状归invalid_response，供应商真实原因未知 | 保留 |
| L052 parseCompletion | 验唯一choice、stop、assistant、非空正文、无工具/拒答 | 有用完整性保护；丢弃未完成响应的全部部分结果/usage，F18 | 保留保护，诊断修改后保留 |
| L053 invalid | 构建安全解析错误 | 只留reason不留finish_reason实际值，无法区分length/content_filter等 | 修改后保留 |
| L073 isRecord | 流式解析object判断 | 与record语义重复，P3 | 可剔除重复定义，不优先 |
| L074 hasOpenRouterReasoningText | 判reasoning_details是否有文本 | 脱敏observe_reasoning未启用，当前默认路径不用；其他作答有用途 | 保留共享用途 |
| L078 readWithAbort | 流读取与abort竞争，避免悬挂等待 | abort后没取消reader/释放锁，底层资源依赖fetch；不用于本次非流式脱敏 | 修改后保留 |
| L081 cleanup | 移除流读取abort监听 | 必要清理 | 无独立缺陷证据 | 保留 |
| L082 onAbort | 流读取停止时拒绝Promise | reader可能仍读，F08资源边界 | 修改后保留 |
| L088 parseStreamingCompletion | 解析SSE并收集正文、用量、思考活动 | 不在当前脱敏路径；buffer/text无显式字节限；流式工具/拒答校验比非流式弱 | 修改后保留共享职责 |
| L095 activity | 生成安全推理事件时间统计 | 不证明正文生成/页级进度；当前脱敏不使用 | 保留 |
| L096 invalid（流式） | 携活动证据的安全错误 | 实际finish_reason仍被归一化，F18 | 修改后保留 |
| L097 observe | 记录同来源推理事件首末/间隔 | 只描述活动，不证明供应商健康或回答正确 | 保留 |
| L104 handleEvent | 解析单SSE事件和choice/delta | 工具调用/refusal未按非流式同等拒绝，非本次脱敏路径 | 修改后保留 |
| L126 consumeLine | 汇总data行，空行触发事件 | 必要协议处理；边界由handleEvent继承 | 保留 |
| L143 createModelApiClient | 创建complete/completeJson与测试传输 | 必要复用；不重试收费调用 | 注入传输绕过真实槽位，不能据替身测试推全链路，F20 | 保留 |
| L144 complete（内层） | 配置/凭证、HTTP、计时、响应解析 | 必要真实请求边界 | F08/F09；response.json依赖abort响应；错误日志在统一abortError转换前记录，原因口径可不同 | 修改后保留 |
| L173 abort | 记录第一次timeout/cancel并abort | 必要本地首因保护 | 上游reason已丢失，只剩两类，F08 | 修改后保留 |
| L176 cancel（内层） | 上游signal变cancelled | 必要传播 | timeout/任务取消语义压平，F08 | 修改后保留 |
| L177 abortError | 将内层abort状态变安全API错误 | 必要错误边界 | local_deadline不区分具体层级；远端仍可能生成 | 修改后保留 |
| L229 complete（外层） | 全局槽位与含排队的总请求timer | 必要，但与内层/业务重复计时 | F08/F10；失败不返回已知queue_wait_ms | 修改后保留 |
| L232 cancel（外层） | 上游取消转外层controller | 必要 | 不保留reason，F08 | 修改后保留 |
| L236 onAcquired | 记录槽位排队毫秒 | 必要观测钩子 | 仅成功返回附带，失败丢失；F10 | 修改后保留 |
| L240 completeJson | complete后JSON.parse与业务validator | 有用共享入口；脱敏自解析不用此入口 | 与业务围栏兼容策略不同，不能机械合并；无独立生产未用问题 | 保留 |

### 4.2 G = server/concurrency.ts

| ID/函数 | 用途与价值 | 具体风险/影响 | 复判 |
|---|---|---|---|
| G015 AgentConcurrencyConfigurationError.constructor | 标识并发配置冲突 | 必要错误类型；名字带Agent但API复用 | 保留 |
| G021 openConcurrencyDatabase | 私有SQLite目录/权限/表初始化 | 必要跨进程配置 | 同步SQLite busy最多5秒可阻塞事件循环；每请求重复打开，真实占比未知 | 修改后保留 |
| G033 readSavedWorkerConcurrencySettings | 读保存值并验API≤8/Agent≤4 | 必要；DB设置优先env | 每请求IO；与env上限32不一致，F07 | 修改后保留边界说明 |
| G043 saveWorkerConcurrencySettings | 保存经验证的并发设置 | 必要配置接口 | gate已有实例不会自动换limit，读新值后可能配置冲突需重启 | 保留并核对产品契约 |
| G055 configuredLimit | 解析env整数1–32 | 必要env入口 | 全局API并非恒定硬限8；F07 | 修改后保留一致契约 |
| G064 readConcurrencySettings | 已保存配置优先，否则env/default | 必要统一来源 | 与运行中gate缓存限额可能不一致 | 保留职责 |
| G073 processIsAlive | kill(pid,0)探进程 | 必要回收前提 | PID复用认为仍活；权限错误保守认为活，F11类风险 | 修改后保留 |
| G081 delay | 可取消的槽位轮询等待 | 必要 | 有同步重查abort，正常无漏唤醒证据 | 保留 |
| G084 finish | 清timer/监听并完成delay | 必要cleanup | 无独立缺陷证据 | 保留 |
| G101 AgentConcurrencyGate.constructor | 建槽位/owner表并注册进程 | 必要跨进程互斥 | 同步事务/配置冲突；跨机器不在当前边界 | 保留 |
| G124 transaction | BEGIN IMMEDIATE +提交/回滚 | 必要；原子抢槽 | busy同步阻塞；回滚异常AggregateError可能上层误分类network | 修改后保留 |
| G140 pruneStaleOwners | 清死进程槽位/旧同PIDtoken | 必要；防崩溃永久占槽 | 只查进程存活，不检查活进程里的挂死调用；F09 | 修改后保留 |
| G151 registerProcess | 配置一致性检查并登记owner | 必要 | 不同进程不同limit直接拒绝，运维切配置需要共同边界 | 保留 |
| G164 reserveSlot | 事务抢第一个空位 | 必要硬并发保护 | 无FIFO，250ms轮询可饿死/超时；F07 | 修改后保留 |
| G178 releaseSlot | 精确owner/token/lease删除槽位 | 必要；防误释放 | 释放SQL失败仍active--，DB槽位留到死进程回收，可能减容量 | 修改后保留 |
| G182 run | 等槽→执行→无论成败释放 | 必要；单处限制并发 | 只在等待阶段响应signal；execute不结束就不释放；本地取消不等于远端停止 | 修改后保留 |
| G205 close | 无active才注销owner并关闭DB | 必要资源清理 | active未收束会throw；生产API实例关闭未接入，F19 | 修改后保留 |
| G213 createAgentConcurrencyGate | 创建独立gate供测试/实例 | 有用工厂 | 本身无新问题，继承constructor边界 | 保留 |
| G215 getAgentConcurrencyGate | 按root缓存gate并检查limit | 必要共享实例 | 保存新limit后缓存拒绝；配置生命周期需明示 | 保留职责 |
| G223 closeAgentConcurrencyGate | 关闭并移除缓存实例 | 必要清理入口 | active时无法安全强关，符合互斥保护 | 保留 |

### 4.3 T = task-signal.ts；I = materials/state.ts；X = external-call.ts；W = worker-pool.ts

| ID/函数 | 用途与价值 | 具体风险/影响 | 复判 |
|---|---|---|---|
| T010 currentTaskSignal | 获取AsyncLocalStorage任务signal | 有用共享上下文；此队列显式传signal | 不应删除其他业务用途 | 保留 |
| T011 withTaskSignal | 为调用链绑定signal | 有用共享包装 | 与显式参数并存需保持同一任务 | 保留 |
| T016 readStatuses | 同连接事务、2秒statement_timeout读状态 | 必要取消核查 | pool.connect/BEGIN/COMMIT未同等限时，F09/F15 | 修改后保留 |
| T029 watchTaskCancellation | 按pool批量轮询活动尝试，停无效任务 | 必要；材料/设置变化后停止旧工作 | 查库失败暂不取消，可能继续收费但最终发布检查保护；F15 | 修改后保留 |
| T031 abort | 传播上游终止 | 必要 | 丢reason，F08 | 修改后保留 |
| T035 schedule | 单飞批量轮询并在完成后重排 | 有价值；避免每任务3秒各查一次 | 某pool查询悬挂会拖住同组所有task取消；F15 | 修改后保留 |
| T061 dispose | 移任务/监听，空组停timer | 必要生命周期清理 | 不取消已在途DB查询；已disposed检查避免误abort | 保留 |
| I007 invalidateMaterialResults | 附件变化事务内取消旧attempt并清当前步骤/导出 | 必要；旧输入不得发布 | 依赖调用者持workflow锁及事务；签名不强制但文档约定存在 | 保留 |
| I017 invalidateRedactionResults | 设置变化锁全项目题目，取消脱敏/下游并失效导出 | 必要；阻止普通设置路径旧结果发布 | 影响全项目很大但属接口契约；不能在优化中偷偷调用 | 保留 |
| X016 runExternalCall | 唯一call_id、上下文、开始/返回/失败日志 | 必要；关联模型与attempt | elapsed是单次总等待；自身不重试、不加timer；成功info日志可能受日志策略限制 | 保留 |
| W018 createFairQueueHandler | 轮转探测不同业务队列 | 有用公平意图 | cursor在await后改；多个worker共享时可同时从相同队列开始，严格公平未保证 | 修改后保留，不影响持久队列锁 |
| W034 delay | worker空闲/失败退避可取消等待 | 必要 | 初次检查与listener注册之间的窄abort窗口未二次检查；有限idle后仍醒，影响小 | 修改后保留，P2 |
| W037 finish | 清退避timer/监听 | 必要 | 无单独问题证据 | 保留 |
| W051 runWorkerPool | 并发领取循环、资源检查、错误退避 | 必要业务任务池 | runOne/DB悬挂时abort不能强制结束handler，退出可能久等；F09/F15 | 修改后保留 |

## 5. 匿名控制函数逐项说明

纯map/filter/sort/forEach谓词不额外承载独立业务；其必要性是完成对应父函数的转换/筛选/赋值，风险继承父函数。末尾清单逐个列出其位置、上下文和表达式，避免漏审。下面为存在独立异步、状态或副作用边界的匿名函数；不能将其简单算成“普通回调”。

| 所在位置 | 做什么/为什么需要 | 风险/复判 |
|---|---|---|
| R099 returned async unlock | 读owner token，仅当前持有者删锁 | 必要解锁；F11，修改后保留 |
| R300 taskTimer callback | 整题timer到期abort | 必要预算；F08/F09，修改后保留 |
| R302 stallTimer callback | 无新增落盘字段超过停滞预算abort | 必要防假进度；不证明远端无活动，F09，修改后保留 |
| R313 writeChain.then async writer | 复制Map、写快照、更新内存/进度 | 有用单写入入口；F16，保留核心 |
| R381 per-call timeout callback | 按剩余任务/单请求预算中止该调用 | 必要；与其他timer竞争，F08，修改后保留 |
| R384 Promise executor + R388 then/finally | 让abort可结束本地等待，完成后移监听 | 必要；底层可能晚返/继续执行，F08，修改后保留 |
| R440 Array.from async worker | 自主领取cursor下一批；错误时首因abort整题 | 必要补位并发；F05/F07，修改后保留 |
| J124 interval + then/catch/finally | 心跳单飞更新attempt/step、记录恢复/失败 | 必要进度持久化；F10/F15，修改后保留 |
| J141 withLogContext execution | 为模型调用绑定provider/model/任务上下文 | 必要；不能把日志上下文当发布绑定校验 | 保留 |
| J144/J145 nested runExternalCall callback | 传实际call_id，封顶timeout，error关联ID | 必要诊断；F08/F10，修改后保留 |
| S013 queue timer callback | 等槽超时标expired并abort | 必要队列预算；失败等待统计F10，修改后保留 |
| S015 gate.run callback | 获槽后停queue timer、报告等待、执行请求 | 必要；让排队timer不误杀执行阶段 | 保留 |
| L079 Promise executor/L085 handlers | 将reader.read与abort组合、确保只完成一次 | 有用；资源释放缺口，修改后保留 |
| L179/L234 timer callbacks | 内层HTTPtimer/外层含排队timer | 有边界价值但归因重复，F08，修改后保留 |
| L236 withModelApiSlot execute callback | 真正获槽后调用内层complete | 必要；不是测试替身HTTP直接路径 | 保留 |
| G085 delay Promise executor | 维护可取消轮询延时 | 必要，保留 |
| G152/G165/G179 transaction callbacks | 分别原子注册owner/抢槽/释槽 | 必要；F07公平性、同步busy与释放失败，修改后保留 |
| T038 async polling timer | 按pool汇总任务分表查询，更新取消状态后重排 | 必要；DB等待影响组内所有任务，F15，修改后保留 |
| X020 withLogContext async callback | 包裹一次外部调用日志与计时 | 必要；不负责业务重试 | 保留 |
| W020 returned queue handler | 顺序探测队列并移动cursor | 有用；多worker严格公平未证实，修改后保留 |
| W036 delay Promise executor | 空闲/失败延时等待取消 | 必要；窄注册窗口，P2 |
| W058 Array.from async worker | 每任务lane循环执行runOne | 必要；任务fan-out与HTTP槽位需区分，F07/F09 |

## 6. 真实失败证据与禁止推论

项目：`5e3d95f9-2021-48c9-a02f-81ff472bf178`；题目8工作流：`a4b5368b-b014-4c88-910c-8fae80c73017`；本次讨论的失败attempt：`d24fefd6-6b11-49ee-a468-f56d6e35a434`。

H：此前API记录失败，29,753/30,508字段、157次请求、17次retry_count，未发布整份结果；执行器wall_elapsed_ms=842,928，attempt时间跨度约31分51秒，存在计时差异。此次未启动API重新核对数据库，以上是会话内已取得历史响应，不写成当前实时状态。

L：本次使用read-logs按该attempt和`2026-10-13T16:25:00Z`至`16:45:00Z`重读最后时间段：17条匹配、9文件、782,833bytes、malformed=0、incomplete_tail=0、truncated=false。末尾证据：

| UTC日志时刻 | 事件 | 安全字段 |
|---|---|---|
| 16:44:38.268 | structured-137 call.failed | local_deadline，elapsed_ms=24,243 |
| 16:44:38.268 | structured-138 call.failed | local_deadline，elapsed_ms=22,996 |
| 16:44:38.269 | structured-139 call.failed | local_deadline，elapsed_ms=11,090 |
| 16:44:38.269 | structured-140 call.failed | local_deadline，elapsed_ms=7,630 |
| 16:44:38.270 | attempt.failed | redaction_request_timeout |
| 16:44:38.716 | heartbeat.write_failed | last_heartbeat_at=16:26:51.583Z |

这些日志证明同一时刻发生终止与心跳异常；**不证明四个模型请求各自独立运行了180秒，也不证明是休眠或供应商卡住**。此前全范围日志统计有truncated=true，不能把其中reason计数当完整故障频率；同一故障也会在client/external/每字段层重复记录。

## 7. AI继续分析时的决策约束

- 阅读顺序：范围/证据标签 → F问题 → 对应函数 → AST清单/源码。源码摘要变了就重新核对对应结论，不把本文当永久事实。
- 用户要求同时满足准确性与速度。真实整题成功、内容准确性证据、可信耗时缺一不可；失败有界和断点保存只是必要能力。
- 不把缺失字段补成空数组，不跳过原文定位，不截断输入，不让模型重写正文，不发布部分字段，不修改来源文件。
- 不把“上下文很大”推出“最佳批次很大”，不把“本机8个槽位”推出“供应商8路必快”，不把模型或测试替身的空映射推出准确脱敏。
- 不通过延长等待、无限重试、盲目加并发掩盖故障；有界拆分也要解释它解决的是容量、格式还是识别问题。
- 不删除来源哈希、最终事务绑定和字段覆盖这类必要保护；历史元数据冗余已删，不应再让模型回传页/附件结构来重复确认。
- 不将全部函数重构当作目标。明确可剔除的是无用途参数/薄包装；保留正常且低耦合的小函数。
- 本文为审查产物；修复和真实业务执行须沿用用户当时授权与仓库规则。不要凭本文自动重跑失败题或调整项目配置。

## 8. 仍需证据才能定案的事项

| 未知 | 会改变什么决定 | 当前证据缺口 |
|---|---|---|
| 时间/暂停首因 | 是否调整请求/任务timeout及归因 | 未取得暂停/恢复/事件循环延迟与同一时钟时间线 |
| 真实批次输出token与finish_reason | 调整打包或故障后缩批 | 当前只留统一incomplete_finish_reason，不能断言都是length |
| 单题与多题8路吞吐、排队公平性 | 默认并发4/8或调度策略 | 8路仅替身测试，失败排队统计也不完整 |
| 漏识别与误改率 | 准确性保护是否足够 | 缺独立标注/审阅的真实原文对照，不得输出原文到普通日志 |
| 相同workflow活动尝试竞争可达性 | F13需要哪层阻止/校验 | 普通失效路由已保护，环境默认变更等入口需再追踪 |
| 断点锁回收竞争与损坏恢复 | F11修复方案 | 未运行跨进程交错/崩溃复现 |

以上是有缺口的逐函数分析；不是修复完成报告。末尾AST清单只校对覆盖范围，不作为业务测试。

## 9. AST函数完整清单与源码指纹

下面清单由本次读取的TypeScript源码生成。命名函数的必要性、风险与复判见第3–4节；纯集合回调继承所属函数的结论，片段说明其具体转换。独立控制回调还须结合第5节。测试文件未纳入生产函数清单，其验证边界见F20。

命名函数/方法/具名闭包 **129** 个，匿名回调 **173** 个，共 **302** 个可执行函数节点（11个生产源码文件）。嵌套函数单独计数；接口中的函数类型不计。五个直接模块与扩查共享依赖分别列于范围说明。

| 文件 | 行数（含注释空行） | 命名函数 | 匿名回调 | SHA-256 |
|---|---:|---:|---:|---|
| [server/materials/redaction.ts](../../server/materials/redaction.ts) | 473 | 43 | 94 | `cf325a20e49948faea9874af0e52989666bc781701dc29f0333919de05f80f42` |
| [server/materials/redaction-jobs.ts](../../server/materials/redaction-jobs.ts) | 189 | 13 | 33 | `27db98cc07e287a5006507572bf644dc1229d3a24d8921c7508e03780e693bfe` |
| [server/materials/redaction-config.ts](../../server/materials/redaction-config.ts) | 43 | 5 | 5 | `78b0ca5bac7212425cb1f011bedd82a7caaf5cfc099ee36ba99198307df800b8` |
| [server/materials/redaction-execution.ts](../../server/materials/redaction-execution.ts) | 19 | 2 | 1 | `5a4af3809f12008fc4868500e18775b81c859d3d59a80f27303bfcc7582b3b48` |
| [server/llm-api/concurrency.ts](../../server/llm-api/concurrency.ts) | 23 | 4 | 2 | `fe8b0e51443c035c05421f7204459f89138daa344e385fb5328ccb2fecc87a93` |
| [server/llm-api/client.ts](../../server/llm-api/client.ts) | 258 | 28 | 17 | `96daa8e393f09d2ae1914cab65cd52cf746c89dac820fb8a9fe7e5ff71beaaca` |
| [server/concurrency.ts](../../server/concurrency.ts) | 226 | 20 | 8 | `6e223053595445d48565f91dac9f261ae352f65be62cf049d8e9e9a316e5c15a` |
| [server/task-signal.ts](../../server/task-signal.ts) | 62 | 7 | 7 | `4ae5078f40d334517f5ab99cc47e000e27893dd66d2803f4977520edfc977388` |
| [server/materials/state.ts](../../server/materials/state.ts) | 25 | 2 | 0 | `eb8d8afe941ae170d842d94e9b61461ed28bd6721ad844a839a2991cf2ddabc9` |
| [server/external-call.ts](../../server/external-call.ts) | 33 | 1 | 1 | `11e4bb612b5343fcd3c6536abe8d5d1abba50aa1953df6dc3c4c4426f66571b2` |
| [server/worker-pool.ts](../../server/worker-pool.ts) | 83 | 4 | 5 | `b5421dc5521d741a1ffe1648d99bcfe404731dd9e02049eecec7cb8d03e13989` |

### 匿名回调清单

每行均关联已审查的父函数；“构造/转换集合”不是独立新功能，片段给出具体内容。它的必要性是执行父函数中的该转换，负面影响与复判继承所列父函数；计时/异步/写入回调同时按§5的独立副作用边界判断。

| 回调ID | 源码位置 | 所属命名函数 | 用途 | 当前源码片段 | 必要性/风险/复判依据 |
|---|---|---|---|---|---|
| R-A001 | [L46](../../server/materials/redaction.ts:46) | R043 structuredRetryFeedback | 谓词筛选/判定：['material_id','target_id','expected_page','expected_count','actual_count'].filter | `key=>typeof details[key]==='string'&#124;&#124;typeof details[key]==='number'` | R043风险/结论；控制回调另见§5 |
| R-A002 | [L46](../../server/materials/redaction.ts:46) | R043 structuredRetryFeedback | 构造/转换集合：unt'].filter(key=>typeof details[key]==='string'&#124;&#124;typeof details[key]==='number').map | `key=>[key,details[key]]` | R043风险/结论；控制回调另见§5 |
| R-A003 | [L47](../../server/materials/redaction.ts:47) | R043 structuredRetryFeedback | 构造/转换集合：['missing_target_ids','duplicate_target_ids','unexpected_target_ids'].flatMap | `key=>Array.isArray(details[key])?[[key,(details[key] as unknown[]).filter((value):value is string=>typeof value==='string').slice(0,16)]]:[]` | R043风险/结论；控制回调另见§5 |
| R-A004 | [L47](../../server/materials/redaction.ts:47) | R043 structuredRetryFeedback | 谓词筛选/判定：(details[key] as unknown[]).filter | `(value):value is string=>typeof value==='string'` | R043风险/结论；控制回调另见§5 |
| R-A005 | [L59](../../server/materials/redaction.ts:59) | R058 withCallHistory | 构造/转换集合：calls.map | `call=>call.usage` | R058风险/结论；控制回调另见§5 |
| R-A006 | [L59](../../server/materials/redaction.ts:59) | R058 withCallHistory | 闭包适配/业务回调：calls.reduce | `(sum,call)=>sum+call.duration_ms` | R058风险/结论；控制回调另见§5 |
| R-A007 | [L59](../../server/materials/redaction.ts:59) | R058 withCallHistory | 构造/转换集合：calls.map | `call=>call.call_id` | R058风险/结论；控制回调另见§5 |
| R-A008 | [L65](../../server/materials/redaction.ts:65) | R065 normalize | 构造/转换集合：item.map | `value=>value===undefined?null:normalize(value)` | R065风险/结论；控制回调另见§5 |
| R-A009 | [L65](../../server/materials/redaction.ts:65) | R065 normalize | 谓词筛选/判定：Object.entries(item).filter | `([,value])=>value!==undefined` | R065风险/结论；控制回调另见§5 |
| R-A010 | [L65](../../server/materials/redaction.ts:65) | R065 normalize | 排序比较：Object.entries(item).filter(([,value])=>value!==undefined).sort | `([a],[b])=>a.localeCompare(b)` | R065风险/结论；控制回调另见§5 |
| R-A011 | [L65](../../server/materials/redaction.ts:65) | R065 normalize | 构造/转换集合：s(item).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map | `([key,value])=>[key,normalize(value)]` | R065风险/结论；控制回调另见§5 |
| R-A012 | [L69](../../server/materials/redaction.ts:69) | R068 aggregateUsage | 谓词筛选/判定：usages.some | `value=>!isRecord(value)` | R068风险/结论；控制回调另见§5 |
| R-A013 | [L71](../../server/materials/redaction.ts:71) | R070 merge | 谓词筛选/判定：values.every | `value=>typeof value==='number'` | R070风险/结论；控制回调另见§5 |
| R-A014 | [L71](../../server/materials/redaction.ts:71) | R070 merge | 闭包适配/业务回调：values.reduce | `(sum,value)=>sum+(value as number)` | R070风险/结论；控制回调另见§5 |
| R-A015 | [L73](../../server/materials/redaction.ts:73) | R070 merge | 谓词筛选/判定：Object.keys(values[0]!).filter | `key=>values.every(value=>Object.hasOwn(value,key))` | R070风险/结论；控制回调另见§5 |
| R-A016 | [L73](../../server/materials/redaction.ts:73) | R070 merge | 谓词筛选/判定：values.every | `value=>Object.hasOwn(value,key)` | R070风险/结论；控制回调另见§5 |
| R-A017 | [L74](../../server/materials/redaction.ts:74) | R070 merge | 构造/转换集合：common.flatMap | `key=>{const value=merge(values.map(item=>(item as Record<string,unknown>)[key]));return value===undefined?[]:[[key,value]];}` | R070风险/结论；控制回调另见§5 |
| R-A018 | [L74](../../server/materials/redaction.ts:74) | R070 merge | 构造/转换集合：values.map | `item=>(item as Record<string,unknown>)[key]` | R070风险/结论；控制回调另见§5 |
| R-A019 | [L76](../../server/materials/redaction.ts:76) | R070 merge | 谓词筛选/判定：values.every | `value=>stableJson(value)===stableJson(values[0])` | R070风险/结论；控制回调另见§5 |
| R-A020 | [L81](../../server/materials/redaction.ts:81) | R080 structuredCheckpointId | 构造/转换集合：source.map | `material=>({material_id:material.material_id,source_sha256:material.source_sha256,pages:material.pages.map(page=>({page:page.page,targets:page…` | R080风险/结论；控制回调另见§5 |
| R-A021 | [L81](../../server/materials/redaction.ts:81) | R080 structuredCheckpointId | 构造/转换集合：material.pages.map | `page=>({page:page.page,targets:page.targets})` | R080风险/结论；控制回调另见§5 |
| R-A022 | [L87](../../server/materials/redaction.ts:87) | R087 saveStructuredCheckpoint | 闭包适配/业务回调：returned/assigned callback | `()=>{}` | R087风险/结论；控制回调另见§5 |
| R-A023 | [L99](../../server/materials/redaction.ts:99) | R094 ownCheckpoint | 闭包适配/业务回调：returned/assigned callback | `async()=>{ try{const owner=JSON.parse(await readFile(lockPath,'utf8'));if(owner.token===token)await rm(lockPath,{force:true});} catch(error){i…` | R094风险/结论；控制回调另见§5 |
| R-A024 | [L130](../../server/materials/redaction.ts:130) | R127 collectStructuredTargets | 遍历并构造/赋值：block.items.forEach | `(text,index)=>{if(text.length&#124;&#124;includeEmpty)targets.push({target_id:ˋ${block.id}/item/${index}ˋ,text});}` | R127风险/结论；控制回调另见§5 |
| R-A025 | [L133](../../server/materials/redaction.ts:133) | R127 collectStructuredTargets | 遍历并构造/赋值：block.rows.forEach | `(row,rowIndex)=>row.cells.forEach((cell,cellIndex)=>{if(cell.text.length&#124;&#124;includeEmpty)targets.push({target_id:ˋ${block.id}/row/${rowIndex}/ce…` | R127风险/结论；控制回调另见§5 |
| R-A026 | [L133](../../server/materials/redaction.ts:133) | R127 collectStructuredTargets | 遍历并构造/赋值：row.cells.forEach | `(cell,cellIndex)=>{if(cell.text.length&#124;&#124;includeEmpty)targets.push({target_id:ˋ${block.id}/row/${rowIndex}/cell/${cellIndex}ˋ,text:cell.text});}` | R127风险/结论；控制回调另见§5 |
| R-A027 | [L134](../../server/materials/redaction.ts:134) | R127 collectStructuredTargets | 遍历并构造/赋值：block.footnotes?.forEach | `(text,index)=>{if(text.length&#124;&#124;includeEmpty)targets.push({target_id:ˋ${block.id}/footnote/${index}ˋ,text});}` | R127风险/结论；控制回调另见§5 |
| R-A028 | [L143](../../server/materials/redaction.ts:143) | R140 createTargetSetters | 遍历并构造/赋值：block.items.forEach | `(_,index)=>setters.set(ˋ${block.id}/item/${index}ˋ,text=>{block.items[index]=text;})` | R140风险/结论；控制回调另见§5 |
| R-A029 | [L143](../../server/materials/redaction.ts:143) | R140 createTargetSetters | 闭包适配/业务回调：setters.set | `text=>{block.items[index]=text;}` | R140风险/结论；控制回调另见§5 |
| R-A030 | [L145](../../server/materials/redaction.ts:145) | R140 createTargetSetters | 闭包适配/业务回调：setters.set | `text=>{block.caption=text;}` | R140风险/结论；控制回调另见§5 |
| R-A031 | [L146](../../server/materials/redaction.ts:146) | R140 createTargetSetters | 遍历并构造/赋值：block.rows.forEach | `(row,rowIndex)=>row.cells.forEach((cell,cellIndex)=>setters.set(ˋ${block.id}/row/${rowIndex}/cell/${cellIndex}ˋ,text=>{cell.text=text;}))` | R140风险/结论；控制回调另见§5 |
| R-A032 | [L146](../../server/materials/redaction.ts:146) | R140 createTargetSetters | 遍历并构造/赋值：row.cells.forEach | `(cell,cellIndex)=>setters.set(ˋ${block.id}/row/${rowIndex}/cell/${cellIndex}ˋ,text=>{cell.text=text;})` | R140风险/结论；控制回调另见§5 |
| R-A033 | [L146](../../server/materials/redaction.ts:146) | R140 createTargetSetters | 闭包适配/业务回调：setters.set | `text=>{cell.text=text;}` | R140风险/结论；控制回调另见§5 |
| R-A034 | [L147](../../server/materials/redaction.ts:147) | R140 createTargetSetters | 遍历并构造/赋值：block.footnotes?.forEach | `(_,index)=>setters.set(ˋ${block.id}/footnote/${index}ˋ,text=>{block.footnotes![index]=text;})` | R140风险/结论；控制回调另见§5 |
| R-A035 | [L147](../../server/materials/redaction.ts:147) | R140 createTargetSetters | 闭包适配/业务回调：setters.set | `text=>{block.footnotes![index]=text;}` | R140风险/结论；控制回调另见§5 |
| R-A036 | [L148](../../server/materials/redaction.ts:148) | R140 createTargetSetters | 闭包适配/业务回调：setters.set | `text=>{block.text=text;}` | R140风险/结论；控制回调另见§5 |
| R-A037 | [L163](../../server/materials/redaction.ts:163) | R162 findMappedSpans | 构造/转换集合：normalizeMappedText(needle).map | `item=>item.value` | R162风险/结论；控制回调另见§5 |
| R-A038 | [L171](../../server/materials/redaction.ts:171) | R162 findMappedSpans | 谓词筛选/判定：query.every | `(character,offset)=>haystack[index+offset]?.value===character` | R162风险/结论；控制回调另见§5 |
| R-A039 | [L179](../../server/materials/redaction.ts:179) | R179 maskName | 谓词筛选/判定：compoundSurnames.find | `candidate=>value.startsWith(candidate)` | R179风险/结论；控制回调另见§5 |
| R-A040 | [L181](../../server/materials/redaction.ts:181) | R180 maskPhone | 构造/转换集合：characters.flatMap | `(character,index)=>/\p{N}/u.test(character)?[index]:[]` | R180风险/结论；控制回调另见§5 |
| R-A041 | [L184](../../server/materials/redaction.ts:184) | R180 maskPhone | 构造/转换集合：characters.map | `(character,index)=>/\p{N}/u.test(character)&&!visible.has(index)?'*':character` | R180风险/结论；控制回调另见§5 |
| R-A042 | [L190](../../server/materials/redaction.ts:190) | R186 replacementFor | 谓词筛选/判定：maskSpan.filter | `candidate=>candidate.start>span.start` | R186风险/结论；控制回调另见§5 |
| R-A043 | [L191](../../server/materials/redaction.ts:191) | R186 replacementFor | 构造/转换集合：givenNames.map | `candidate=>({...candidate,replacement:'**'})` | R186风险/结论；控制回调另见§5 |
| R-A044 | [L198](../../server/materials/redaction.ts:198) | R186 replacementFor | 谓词筛选/判定：maskSpans.every | `(candidate,index)=>index===0&#124;&#124;candidate.start>=maskSpans[index-1]!.end` | R186风险/结论；控制回调另见§5 |
| R-A045 | [L199](../../server/materials/redaction.ts:199) | R186 replacementFor | 构造/转换集合：maskSpans.map | `candidate=>({...candidate,replacement:starMask(source.slice(candidate.start,candidate.end))})` | R186风险/结论；控制回调另见§5 |
| R-A046 | [L211](../../server/materials/redaction.ts:211) | R203 applyStructuredRedactions | 排序比较：spans.sort | `(a,b)=>a.start-b.start&#124;&#124;a.end-b.end` | R203风险/结论；控制回调另见§5 |
| R-A047 | [L240](../../server/materials/redaction.ts:240) | R238 validateStructuredOutput | 构造/转换集合：source.flatMap | `material=>material.pages.flatMap(page=>page.targets)` | R238风险/结论；控制回调另见§5 |
| R-A048 | [L240](../../server/materials/redaction.ts:240) | R238 validateStructuredOutput | 构造/转换集合：material.pages.flatMap | `page=>page.targets` | R238风险/结论；控制回调另见§5 |
| R-A049 | [L241](../../server/materials/redaction.ts:241) | R238 validateStructuredOutput | 构造/转换集合：targets.map | `target=>target.wire_id!` | R238风险/结论；控制回调另见§5 |
| R-A050 | [L253](../../server/materials/redaction.ts:253) | R238 validateStructuredOutput | 谓词筛选/判定：[...expected].filter | `id=>!fields.has(id)` | R238风险/结论；控制回调另见§5 |
| R-A051 | [L255](../../server/materials/redaction.ts:255) | R238 validateStructuredOutput | 构造/转换集合：source.map | `material=>({material_id:material.material_id,pages:material.pages.map(page=>{ const structure=JSON.parse(JSON.stringify(page.structure)) as Do…` | R238风险/结论；控制回调另见§5 |
| R-A052 | [L255](../../server/materials/redaction.ts:255) | R238 validateStructuredOutput | 构造/转换集合：material.pages.map | `page=>{ const structure=JSON.parse(JSON.stringify(page.structure)) as DocumentBlock[],setters=createTargetSetters(structure); const redactions…` | R238风险/结论；控制回调另见§5 |
| R-A053 | [L271](../../server/materials/redaction.ts:271) | R271 renderMaterialPages | 构造/转换集合：material.pages.map | `page=>ˋ【原附件第 ${page.page} 页】\n${page.text}ˋ` | R271风险/结论；控制回调另见§5 |
| R-A054 | [L275](../../server/materials/redaction.ts:275) | R273 redactStructuredMaterials | 构造/转换集合：options.materials.map | `material=>{ const pageStructures=material.pages.map(page=>page.structure?.length?page.structure:[{id:ˋp${page.page}-textˋ,kind:'paragraph' as …` | R273风险/结论；控制回调另见§5 |
| R-A055 | [L276](../../server/materials/redaction.ts:276) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `page=>page.structure?.length?page.structure:[{id:ˋp${page.page}-textˋ,kind:'paragraph' as const,text:page.text}]` | R273风险/结论；控制回调另见§5 |
| R-A056 | [L277](../../server/materials/redaction.ts:277) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `(page,index)=>({page:page.page,targets:collectStructuredTargets(pageStructures[index]!).map(target=>({...target,wire_id:ˋf${++fieldNumber}ˋ}))…` | R273风险/结论；控制回调另见§5 |
| R-A057 | [L277](../../server/materials/redaction.ts:277) | R273 redactStructuredMaterials | 构造/转换集合：collectStructuredTargets(pageStructures[index]!).map | `target=>({...target,wire_id:ˋf${++fieldNumber}ˋ})` | R273风险/结论；控制回调另见§5 |
| R-A058 | [L280](../../server/materials/redaction.ts:280) | R273 redactStructuredMaterials | 谓词筛选/判定：projectRules.split('\n').some | `line=>/(?:价款&#124;金额)[^\n]*(?:原样保留&#124;不脱敏)/u.test(line)` | R273风险/结论；控制回调另见§5 |
| R-A059 | [L294](../../server/materials/redaction.ts:294) | R273 redactStructuredMaterials | 闭包适配/业务回调：returned/assigned callback | `(request:ModelApiRequest)=>createModelApiClient().complete(request)` | R273风险/结论；控制回调另见§5 |
| R-A060 | [L300](../../server/materials/redaction.ts:300) | R273 redactStructuredMaterials | 定时控制/轮询：setTimeout | `()=>controller.abort(stopError('redaction_task_timeout'))` | R273风险/结论；控制回调另见§5 |
| R-A061 | [L302](../../server/materials/redaction.ts:302) | R273 redactStructuredMaterials | 定时控制/轮询：setInterval | `()=>{if(performance.now()-lastProgress>=policy.stall_timeout_ms)controller.abort(stopError('redaction_progress_stalled'));}` | R273风险/结论；控制回调另见§5 |
| R-A062 | [L306](../../server/materials/redaction.ts:306) | R273 redactStructuredMaterials | 构造/转换集合：source.flatMap | `material=>material.pages.flatMap(page=>page.targets.map(target=>[structuredFieldKey(material.material_id,page.page,target.target_id),target] a…` | R273风险/结论；控制回调另见§5 |
| R-A063 | [L306](../../server/materials/redaction.ts:306) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.flatMap | `page=>page.targets.map(target=>[structuredFieldKey(material.material_id,page.page,target.target_id),target] as const)` | R273风险/结论；控制回调另见§5 |
| R-A064 | [L306](../../server/materials/redaction.ts:306) | R273 redactStructuredMaterials | 构造/转换集合：page.targets.map | `target=>[structuredFieldKey(material.material_id,page.page,target.target_id),target] as const` | R273风险/结论；控制回调另见§5 |
| R-A065 | [L313](../../server/materials/redaction.ts:313) | R312 commitFields | 异步完成/失败/清理：writeChain.then | `async()=>{ guard();progress.phase='saving';notify();const at=performance.now(),next=new Map(checkpointFields); for(const [key,value] of entrie…` | R312风险/结论；控制回调另见§5 |
| R-A066 | [L332](../../server/materials/redaction.ts:332) | R273 redactStructuredMaterials | 谓词筛选/判定：value.some | `item=>!isRecord(item)&#124;&#124;typeof item.source_text!=='string'&#124;&#124;typeof item.kind!=='string'&#124;&#124;(item.mask_text!==undefined&&typeof item.mask_text!=='…` | R273风险/结论；控制回调另见§5 |
| R-A067 | [L343](../../server/materials/redaction.ts:343) | R343 wireTargets | 构造/转换集合：batch.pages.flatMap | `page=>page.targets.map(target=>({target_id:target.wire_id!,text:target.text}))` | R343风险/结论；控制回调另见§5 |
| R-A068 | [L343](../../server/materials/redaction.ts:343) | R343 wireTargets | 构造/转换集合：page.targets.map | `target=>({target_id:target.wire_id!,text:target.text})` | R343风险/结论；控制回调另见§5 |
| R-A069 | [L344](../../server/materials/redaction.ts:344) | R344 outputEstimate | 构造/转换集合：targets.map | `target=>({target_id:target.target_id,redactions:[{source_text:target.text,mask_text:target.text,kind:'identifier'}]})` | R344风险/结论；控制回调另见§5 |
| R-A070 | [L381](../../server/materials/redaction.ts:381) | R370 processBatch | 定时控制/轮询：setTimeout | `()=>callController.abort(stopError(taskDeadlineLimits?'redaction_task_timeout':'redaction_request_timeout'))` | R370风险/结论；控制回调另见§5 |
| R-A071 | [L384](../../server/materials/redaction.ts:384) | R370 processBatch | Promise执行/收束：Promise | `(resolve,reject)=>{ const aborted=()=>reject(callController.signal.reason??stopError('redaction_cancelled')); callController.signal.addEventLi…` | R370风险/结论；控制回调另见§5 |
| R-A072 | [L388](../../server/materials/redaction.ts:388) | R370 processBatch | 异步完成/失败/清理：Promise.resolve().then | `()=>executeApi({config:{...config.api,max_tokens:Math.min(outputLimit,Math.max(1024,outputEstimate(targets)))},signal:callController.signal,ti…` | R370风险/结论；控制回调另见§5 |
| R-A073 | [L388](../../server/materials/redaction.ts:388) | R370 processBatch | 异步完成/失败/清理：action-structured-${key}${retry?ˋ-retry-${retry}ˋ:''}ˋ)).then(resolve,reject).finally | `()=>callController.signal.removeEventListener('abort',aborted)` | R370风险/结论；控制回调另见§5 |
| R-A074 | [L429](../../server/materials/redaction.ts:429) | R370 processBatch | 构造/转换集合：batch.pages.flatMap | `page=>page.targets` | R370风险/结论；控制回调另见§5 |
| R-A075 | [L440](../../server/materials/redaction.ts:440) | R273 redactStructuredMaterials | 构造/转换集合：Array.from | `async()=>{ try{while(cursor<batches.length){guard();const index=cursor++;await processBatch(batches[index]!,String(index+1),index+1);}} catch(…` | R273风险/结论；控制回调另见§5 |
| R-A076 | [L446](../../server/materials/redaction.ts:446) | R273 redactStructuredMaterials | 构造/转换集合：source.flatMap | `material=>material.pages.flatMap(page=>page.targets.map(target=>({target_id:target.wire_id,redactions:checkpointFields.get(structuredFieldKey(…` | R273风险/结论；控制回调另见§5 |
| R-A077 | [L446](../../server/materials/redaction.ts:446) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.flatMap | `page=>page.targets.map(target=>({target_id:target.wire_id,redactions:checkpointFields.get(structuredFieldKey(material.material_id,page.page,ta…` | R273风险/结论；控制回调另见§5 |
| R-A078 | [L446](../../server/materials/redaction.ts:446) | R273 redactStructuredMaterials | 构造/转换集合：page.targets.map | `target=>({target_id:target.wire_id,redactions:checkpointFields.get(structuredFieldKey(material.material_id,page.page,target.target_id))})` | R273风险/结论；控制回调另见§5 |
| R-A079 | [L447](../../server/materials/redaction.ts:447) | R273 redactStructuredMaterials | 构造/转换集合：calls.map | `call=>call.usage` | R273风险/结论；控制回调另见§5 |
| R-A080 | [L447](../../server/materials/redaction.ts:447) | R273 redactStructuredMaterials | 闭包适配/业务回调：calls.reduce | `(sum,call)=>sum+call.duration_ms` | R273风险/结论；控制回调另见§5 |
| R-A081 | [L447](../../server/materials/redaction.ts:447) | R273 redactStructuredMaterials | 构造/转换集合：calls.map | `call=>call.call_id` | R273风险/结论；控制回调另见§5 |
| R-A082 | [L453](../../server/materials/redaction.ts:453) | R273 redactStructuredMaterials | 构造/转换集合：source.flatMap | `material=>material.pages.flatMap(page=>page.targets.map(target=>({target_id:target.wire_id,text:target.text})))` | R273风险/结论；控制回调另见§5 |
| R-A083 | [L453](../../server/materials/redaction.ts:453) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.flatMap | `page=>page.targets.map(target=>({target_id:target.wire_id,text:target.text}))` | R273风险/结论；控制回调另见§5 |
| R-A084 | [L453](../../server/materials/redaction.ts:453) | R273 redactStructuredMaterials | 构造/转换集合：page.targets.map | `target=>({target_id:target.wire_id,text:target.text})` | R273风险/结论；控制回调另见§5 |
| R-A085 | [L457](../../server/materials/redaction.ts:457) | R273 redactStructuredMaterials | 构造/转换集合：output.materials.map | `material=>({material_id:material.material_id,pages:material.pages.map(({page,text,structure})=>({page,text,structure}))})` | R273风险/结论；控制回调另见§5 |
| R-A086 | [L457](../../server/materials/redaction.ts:457) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `({page,text,structure})=>({page,text,structure})` | R273风险/结论；控制回调另见§5 |
| R-A087 | [L458](../../server/materials/redaction.ts:458) | R273 redactStructuredMaterials | 构造/转换集合：materials.flatMap | `material=>material.pages.map(page=>({material_id:material.material_id,page:page.page}))` | R273风险/结论；控制回调另见§5 |
| R-A088 | [L458](../../server/materials/redaction.ts:458) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `page=>({material_id:material.material_id,page:page.page})` | R273风险/结论；控制回调另见§5 |
| R-A089 | [L459](../../server/materials/redaction.ts:459) | R273 redactStructuredMaterials | 构造/转换集合：materials.map | `(material,index)=>ˋ【附件 ${index+1}】\n\n${renderMaterialPages(material)}\n\n【附件 ${index+1} 结束】ˋ` | R273风险/结论；控制回调另见§5 |
| R-A090 | [L460](../../server/materials/redaction.ts:460) | R273 redactStructuredMaterials | 构造/转换集合：materials.map | `material=>({material_id:material.material_id,markdown:material.pages.map(page=>page.text).join('\n\n')})` | R273风险/结论；控制回调另见§5 |
| R-A091 | [L460](../../server/materials/redaction.ts:460) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `page=>page.text` | R273风险/结论；控制回调另见§5 |
| R-A092 | [L461](../../server/materials/redaction.ts:461) | R273 redactStructuredMaterials | 构造/转换集合：materials.map | `material=>{ const markdownText=material.pages.map(page=>page.text).join('\n\n'),document={format:'redacted-structure-v1',pages:material.pages.…` | R273风险/结论；控制回调另见§5 |
| R-A093 | [L462](../../server/materials/redaction.ts:462) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `page=>page.text` | R273风险/结论；控制回调另见§5 |
| R-A094 | [L462](../../server/materials/redaction.ts:462) | R273 redactStructuredMaterials | 构造/转换集合：material.pages.map | `page=>({page:page.page,blocks:page.structure??[]})` | R273风险/结论；控制回调另见§5 |
| J-A001 | [L28](../../server/materials/redaction-jobs.ts:28) | J023 redactionFailureSummary | 谓词筛选/判定：value.call_ids.filter | `(item):item is string=>typeof item==='string'&&/^[0-9a-f-]{36}$/i.test(item)` | J023风险/结论；控制回调另见§5 |
| J-A002 | [L30](../../server/materials/redaction-jobs.ts:30) | J023 redactionFailureSummary | 构造/转换集合：(['expected_count','actual_count','expected_page','actual_page'] as const).flatMap | `key=>Number.isSafeInteger(value[key])?[[key,value[key] as number]]:[]` | J023风险/结论；控制回调另见§5 |
| J-A003 | [L37](../../server/materials/redaction-jobs.ts:37) | J037 digestMaterials | 构造/转换集合：materials.map | `item=>({material_id:item.material_id,source_sha256:item.source_sha256,artifact_id:item.artifact_id,artifact_sha256:item.artifact_sha256})` | J037风险/结论；控制回调另见§5 |
| J-A004 | [L53](../../server/materials/redaction-jobs.ts:53) | J048 currentSources | 构造/转换集合：(Array.isArray(manifest)?manifest:[]).flatMap | `(item:any,index:number)=>typeof item?.name==='string'?[[item.name,index] as [string,number]]:[]` | J048风险/结论；控制回调另见§5 |
| J-A005 | [L54](../../server/materials/redaction-jobs.ts:54) | J048 currentSources | 排序比较：rows.rows.sort | `(a:any,b:any)=>(order.get(a.original_name)??Number.MAX_SAFE_INTEGER)-(order.get(b.original_name)??Number.MAX_SAFE_INTEGER)&#124;&#124;String(a.material_…` | J048风险/结论；控制回调另见§5 |
| J-A006 | [L67](../../server/materials/redaction-jobs.ts:67) | J060 enqueueRedaction | 谓词筛选/判定：gate.find | `row=>row.ordinal===9` | J060风险/结论；控制回调另见§5 |
| J-A007 | [L68](../../server/materials/redaction-jobs.ts:68) | J060 enqueueRedaction | 谓词筛选/判定：gate.find | `row=>row.ordinal===1` | J060风险/结论；控制回调另见§5 |
| J-A008 | [L68](../../server/materials/redaction-jobs.ts:68) | J060 enqueueRedaction | 谓词筛选/判定：gate.find | `row=>row.ordinal===2` | J060风险/结论；控制回调另见§5 |
| J-A009 | [L76](../../server/materials/redaction-jobs.ts:76) | J060 enqueueRedaction | 谓词筛选/判定：gate.find | `row=>row.ordinal===9` | J060风险/结论；控制回调另见§5 |
| J-A010 | [L77](../../server/materials/redaction-jobs.ts:77) | J060 enqueueRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('attempt.reused',{level:'info',state:'waiting'})` | J060风险/结论；控制回调另见§5 |
| J-A011 | [L84](../../server/materials/redaction-jobs.ts:84) | J060 enqueueRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('attempt.enqueued',{level:'info',state:'waiting',material_count:sources.length})` | J060风险/结论；控制回调另见§5 |
| J-A012 | [L95](../../server/materials/redaction-jobs.ts:95) | J088 readSource | 谓词筛选/判定：parsed.pages.some | `(page:any,index:number)=>page.page!==index+1&#124;&#124;typeof page.text!=='string'` | J088风险/结论；控制回调另见§5 |
| J-A013 | [L111](../../server/materials/redaction-jobs.ts:111) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Dat…` | J103风险/结论；控制回调另见§5 |
| J-A014 | [L115](../../server/materials/redaction-jobs.ts:115) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>{logEvent('attempt.claimed',{level:'info',state:'running'});logEvent('attempt.started',{level:'info',state:'running'});}` | J103风险/结论；控制回调另见§5 |
| J-A015 | [L117](../../server/materials/redaction-jobs.ts:117) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('attempt.recovered_interrupted',{level:'error',state:'failed',threshold_ms:300000,...(row.heartbeat_at?{last_heartbeat_at:new Dat…` | J103风险/结论；控制回调另见§5 |
| J-A016 | [L124](../../server/materials/redaction-jobs.ts:124) | J103 runNextRedaction | 定时控制/轮询：setInterval | `()=>{if(heartbeatInFlight)return;heartbeatInFlight=true;withLogContext(taskContext,()=>pool.query("WITH active AS (UPDATE ai_distill.step_atte…` | J103风险/结论；控制回调另见§5 |
| J-A017 | [L124](../../server/materials/redaction-jobs.ts:124) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>pool.query("WITH active AS (UPDATE ai_distill.step_attempts SET heartbeat_at=now(),result=CASE WHEN $2::jsonb IS NULL THEN result ELSE COA…` | J103风险/结论；控制回调另见§5 |
| J-A018 | [L124](../../server/materials/redaction-jobs.ts:124) | J103 runNextRedaction | 异步完成/失败/清理：URNING workflow_id",[job.id,latestProgress?JSON.stringify(latestProgress):null]).then | `result=>{if(!result.rowCount){if(!heartbeatFailed)logEvent('heartbeat.write_failed',{level:'warn',reason_code:'attempt_not_running',last_heart…` | J103风险/结论；控制回调另见§5 |
| J-A019 | [L124](../../server/materials/redaction-jobs.ts:124) | J103 runNextRedaction | 异步完成/失败/清理：rtbeatAt))});heartbeatFailed=false;lastHeartbeatAt=new Date().toISOString();}}).catch | `error=>{if(!heartbeatFailed){logEvent('heartbeat.write_failed',{level:'error',last_heartbeat_at:lastHeartbeatAt,...classifyLogError(error)});c…` | J103风险/结论；控制回调另见§5 |
| J-A020 | [L124](../../server/materials/redaction-jobs.ts:124) | J103 runNextRedaction | 异步完成/失败/清理：lassifyLogError(error)});console.error('脱敏任务心跳写入失败');}heartbeatFailed=true;}).finally | `()=>{heartbeatInFlight=false;}` | J103风险/结论；控制回调另见§5 |
| J-A021 | [L141](../../server/materials/redaction-jobs.ts:141) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>{ logEvent('attempt.input_validated',{level:'info',material_count:materials.length,page_count:materials.reduce((sum,item)=>sum+item.pages.…` | J103风险/结论；控制回调另见§5 |
| J-A022 | [L142](../../server/materials/redaction-jobs.ts:142) | J103 runNextRedaction | 闭包适配/业务回调：materials.reduce | `(sum,item)=>sum+item.pages.length` | J103风险/结论；控制回调另见§5 |
| J-A023 | [L144](../../server/materials/redaction-jobs.ts:144) | J144 execute | 闭包适配/业务回调：runExternalCall | `call_id=>execute({...options,call_id,timeout_ms:Math.min(options.timeout_ms??1800000,1800000)})` | J144风险/结论；控制回调另见§5 |
| J-A024 | [L145](../../server/materials/redaction-jobs.ts:145) | J145 executeApi | 闭包适配/业务回调：runExternalCall | `async call_id=>{ try{return{...await completeApi({...request,call_id,timeout_ms:Math.min(request.timeout_ms??1800000,1800000)}),call_id};} cat…` | J145风险/结论；控制回调另见§5 |
| J-A025 | [L163](../../server/materials/redaction-jobs.ts:163) | J103 runNextRedaction | 构造/转换集合：_index',storage_path:relative(resolve(root),indexPath),content:output.index}, ].map | `file=>({...file,sha256:hash(file.content),size_bytes:Buffer.byteLength(file.content)})` | J103风险/结论；控制回调另见§5 |
| J-A026 | [L164](../../server/materials/redaction-jobs.ts:164) | J103 runNextRedaction | 闭包适配/业务回调：materials.reduce | `(sum,item)=>sum+item.pages.length` | J103风险/结论；控制回调另见§5 |
| J-A027 | [L177](../../server/materials/redaction-jobs.ts:177) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('state_update.committed',{level:'info',state:'succeeded',material_count:materials.length,page_count:result.page_count,output_byte…` | J103风险/结论；控制回调另见§5 |
| J-A028 | [L177](../../server/materials/redaction-jobs.ts:177) | J103 runNextRedaction | 闭包适配/业务回调：files.reduce | `(sum,file)=>sum+file.size_bytes` | J103风险/结论；控制回调另见§5 |
| J-A029 | [L178](../../server/materials/redaction-jobs.ts:178) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('file.cleanup_or_commit_check_failed',{level:'warn',file_kind:'redaction_checkpoint',...classifyLogError(cleanupError)})` | J103风险/结论；控制回调另见§5 |
| J-A030 | [L183](../../server/materials/redaction-jobs.ts:183) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('attempt.failed',{level:'error',state:'failed',...classified,failure_phase:effectiveFailurePhase})` | J103风险/结论；控制回调另见§5 |
| J-A031 | [L184](../../server/materials/redaction-jobs.ts:184) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('file.cleanup_or_commit_check_failed',{level:'error',file_kind:'redacted_outputs',...classifyLogError(cleanupError)})` | J103风险/结论；控制回调另见§5 |
| J-A032 | [L186](../../server/materials/redaction-jobs.ts:186) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent(updated.rowCount?'state_update.committed':'state_update.unchanged',{level:updated.rowCount?'info':'warn',state:updated.rowCount?'…` | J103风险/结论；控制回调另见§5 |
| J-A033 | [L186](../../server/materials/redaction-jobs.ts:186) | J103 runNextRedaction | 关联日志上下文执行：withLogContext | `()=>logEvent('state_update.failed',{level:'error',...classifyLogError(failure)})` | J103风险/结论；控制回调另见§5 |
| C-A001 | [L12](../../server/materials/redaction-config.ts:12) | C012 normalize | 构造/转换集合：item.map | `value=>value===undefined?null:normalize(value)` | C012风险/结论；控制回调另见§5 |
| C-A002 | [L12](../../server/materials/redaction-config.ts:12) | C012 normalize | 谓词筛选/判定：Object.entries(item).filter | `([,value])=>value!==undefined` | C012风险/结论；控制回调另见§5 |
| C-A003 | [L12](../../server/materials/redaction-config.ts:12) | C012 normalize | 排序比较：Object.entries(item).filter(([,value])=>value!==undefined).sort | `([a],[b])=>a.localeCompare(b)` | C012风险/结论；控制回调另见§5 |
| C-A004 | [L12](../../server/materials/redaction-config.ts:12) | C012 normalize | 构造/转换集合：s(item).filter(([,value])=>value!==undefined).sort(([a],[b])=>a.localeCompare(b)).map | `([key,value])=>[key,normalize(value)]` | C012风险/结论；控制回调另见§5 |
| C-A005 | [L33](../../server/materials/redaction-config.ts:33) | C029 validateRedactionConfig | 谓词筛选/判定：Object.keys(value).some | `key=>!fields.includes(key)` | C029风险/结论；控制回调另见§5 |
| E-A001 | [L12](../../server/materials/redaction-execution.ts:12) | E011 resolveRedactionExecution | 谓词筛选/判定：Object.keys(value).some | `key=>!Object.hasOwn(DEFAULT_REDACTION_EXECUTION,key)` | E011风险/结论；控制回调另见§5 |
| S-A001 | [L13](../../server/llm-api/concurrency.ts:13) | S007 withModelApiSlot | 定时控制/轮询：setTimeout | `()=>{expired=true;controller.abort();}` | S007风险/结论；控制回调另见§5 |
| S-A002 | [L15](../../server/llm-api/concurrency.ts:15) | S007 withModelApiSlot | 闭包适配/业务回调：getAgentConcurrencyGate(gateRoot(root),limit).run | `async()=>{ clearTimeout(timer);options.onAcquired?.(Math.round(performance.now()-started));return await execute(); }` | S007风险/结论；控制回调另见§5 |
| L-A001 | [L11](../../server/llm-api/client.ts:11) | L011 onlyFields | 谓词筛选/判定：Object.keys(value).some | `key=>!fields.includes(key)` | L011风险/结论；控制回调另见§5 |
| L-A002 | [L33](../../server/llm-api/client.ts:33) | L031 requestId | 谓词筛选/判定：ids.find | `(id): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)` | L031风险/结论；控制回调另见§5 |
| L-A003 | [L42](../../server/llm-api/client.ts:42) | L039 providerError | 谓词筛选/判定：[quotaCodes, authCodes, rateCodes, configCodes, providerCodes].some | `codes => codes.has(rawCode)` | L039风险/结论；控制回调另见§5 |
| L-A004 | [L75](../../server/llm-api/client.ts:75) | L074 hasOpenRouterReasoningText | 谓词筛选/判定：value.some | `item=>isRecord(item)&&item.type==='reasoning.text'&&typeof item.text==='string'&&item.text.trim().length>0` | L074风险/结论；控制回调另见§5 |
| L-A005 | [L79](../../server/llm-api/client.ts:79) | L078 readWithAbort | Promise执行/收束：Promise | `(resolve,reject)=>{ let settled=false; const cleanup=()=>signal.removeEventListener('abort',onAbort); const onAbort=()=>{if(settled)return;set…` | L078风险/结论；控制回调另见§5 |
| L-A006 | [L85](../../server/llm-api/client.ts:85) | L078 readWithAbort | 异步完成/失败/清理：reader.read().then | `value=>{if(settled)return;settled=true;cleanup();resolve(value as AbortableReadResult);}` | L078风险/结论；控制回调另见§5 |
| L-A007 | [L85](../../server/llm-api/client.ts:85) | L078 readWithAbort | 异步完成/失败/清理：reader.read().then | `error=>{if(settled)return;settled=true;cleanup();reject(error);}` | L078风险/结论；控制回调另见§5 |
| L-A008 | [L148](../../server/llm-api/client.ts:148) | L144 complete | 构造/转换集合：input.messages.map | `message=>{ onlyFields(message,['role','content']); if(typeof message.role!=='string'&#124;&#124;!['system','user','assistant'].includes(message.role)&#124;&#124;t…` | L144风险/结论；控制回调另见§5 |
| L-A009 | [L179](../../server/llm-api/client.ts:179) | L144 complete | 定时控制/轮询：setTimeout | `() => abort('timeout')` | L144风险/结论；控制回调另见§5 |
| L-A010 | [L182](../../server/llm-api/client.ts:182) | L144 complete | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.call.started',{level:'info',timeout_ms:timeout})` | L144风险/结论；控制回调另见§5 |
| L-A011 | [L201](../../server/llm-api/client.ts:201) | L144 complete | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.call.completed',{level:'info',elapsed_ms:result.duration_ms,token_usage:result.usage,output_bytes:Buffer.byteLength(re…` | L144风险/结论；控制回调另见§5 |
| L-A012 | [L216](../../server/llm-api/client.ts:216) | L144 complete | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.call.completed',{level:'info',elapsed_ms:result.duration_ms,token_usage:result.usage,output_bytes:Buffer.byteLength(re…` | L144风险/结论；控制回调另见§5 |
| L-A013 | [L219](../../server/llm-api/client.ts:219) | L144 complete | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.call.failed',{level:'error',elapsed_ms:Math.round(performance.now()-started),...classifyLogError(error)})` | L144风险/结论；控制回调另见§5 |
| L-A014 | [L234](../../server/llm-api/client.ts:234) | L229 complete | 定时控制/轮询：setTimeout | `()=>{timedOut=true;controller.abort();}` | L229风险/结论；控制回调另见§5 |
| L-A015 | [L236](../../server/llm-api/client.ts:236) | L229 complete | 闭包适配/业务回调：withModelApiSlot | `()=>client.complete({...input,signal:controller.signal})` | L229风险/结论；控制回调另见§5 |
| L-A016 | [L246](../../server/llm-api/client.ts:246) | L240 completeJson | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.validation.failed',{level:'error',...classifyLogError(safe)})` | L240风险/结论；控制回调另见§5 |
| L-A017 | [L254](../../server/llm-api/client.ts:254) | L240 completeJson | 关联日志上下文执行：withLogContext | `()=>logEvent('model_api.validation.failed',{level:'error',...classifyLogError(safe)})` | L240风险/结论；控制回调另见§5 |
| G-A001 | [L82](../../server/concurrency.ts:82) | G081 delay | Promise执行/收束：Promise | `resolvePromise=>{ let timer:ReturnType<typeof setTimeout>&#124;undefined; const finish=()=>{if(timer)clearTimeout(timer);signal?.removeEventListene…` | G081风险/结论；控制回调另见§5 |
| G-A002 | [L148](../../server/concurrency.ts:148) | G140 pruneStaleOwners | 构造/转换集合：ncurrency_owners').all() as {pid:number;token:string;concurrency_limit:number}[]).map | `owner=>[owner.pid,{token:owner.token,limit:owner.concurrency_limit}]` | G140风险/结论；控制回调另见§5 |
| G-A003 | [L152](../../server/concurrency.ts:152) | G151 registerProcess | 闭包适配/业务回调：this.transaction | `()=>{ const owners=this.pruneStaleOwners(); for(const[pid,owner]of owners){ if(pid!==this.pid&&owner.limit!==this.limit)throw new AgentConcurr…` | G151风险/结论；控制回调另见§5 |
| G-A004 | [L165](../../server/concurrency.ts:165) | G164 reserveSlot | 闭包适配/业务回调：this.transaction | `()=>{ const owners=this.pruneStaleOwners(); if([...owners.values()].some(owner=>owner.limit!==this.limit))throw new AgentConcurrencyConfigurat…` | G164风险/结论；控制回调另见§5 |
| G-A005 | [L167](../../server/concurrency.ts:167) | G164 reserveSlot | 谓词筛选/判定：[...owners.values()].some | `owner=>owner.limit!==this.limit` | G164风险/结论；控制回调另见§5 |
| G-A006 | [L168](../../server/concurrency.ts:168) | G164 reserveSlot | 构造/转换集合：abase.query('SELECT slot FROM agent_concurrency_slots').all() as {slot:number}[]).map | `row=>row.slot` | G164风险/结论；控制回调另见§5 |
| G-A007 | [L179](../../server/concurrency.ts:179) | G178 releaseSlot | 闭包适配/业务回调：this.transaction | `()=>{this.database.query('DELETE FROM agent_concurrency_slots WHERE slot=? AND owner_pid=? AND owner_token=? AND lease_token=?').run(slot,this…` | G178风险/结论；控制回调另见§5 |
| G-A008 | [L208](../../server/concurrency.ts:208) | G205 close | 闭包适配/业务回调：this.transaction | `()=>{this.database.query('DELETE FROM agent_concurrency_slots WHERE owner_pid=? AND owner_token=? AND lease_token=?').run(this.pid,PROCESS_TOK…` | G205风险/结论；控制回调另见§5 |
| T-A001 | [L37](../../server/task-signal.ts:37) | T035 schedule | 定时控制/轮询：setTimeout | `async()=>{ current.timer=undefined;current.checking=true; try{ const tasks=[...current.tasks].filter(item=>!item.disposed&&!item.controller.si…` | T035风险/结论；控制回调另见§5 |
| T-A002 | [L40](../../server/task-signal.ts:40) | T035 schedule | 谓词筛选/判定：[...current.tasks].filter | `item=>!item.disposed&&!item.controller.signal.aborted` | T035风险/结论；控制回调另见§5 |
| T-A003 | [L42](../../server/task-signal.ts:42) | T035 schedule | 谓词筛选/判定：tasks.filter | `item=>item.projectSkill===skill` | T035风险/结论；控制回调另见§5 |
| T-A004 | [L46](../../server/task-signal.ts:46) | T035 schedule | 构造/转换集合：selected.map | `item=>item.id` | T035风险/结论；控制回调另见§5 |
| T-A005 | [L47](../../server/task-signal.ts:47) | T035 schedule | 构造/转换集合：rows.map | `row=>[row.id,row.status]` | T035风险/结论；控制回调另见§5 |
| T-A006 | [L50](../../server/task-signal.ts:50) | T035 schedule | 闭包适配/业务回调：withIsolatedLogContext | `()=>logEvent('task.cancellation.poll_recovered',{level:'info'})` | T035风险/结论；控制回调另见§5 |
| T-A007 | [L53](../../server/task-signal.ts:53) | T035 schedule | 闭包适配/业务回调：withIsolatedLogContext | `()=>logEvent('task.cancellation.poll_failed',{level:'error',...classifyLogError(error)})` | T035风险/结论；控制回调另见§5 |
| X-A001 | [L21](../../server/external-call.ts:21) | X016 runExternalCall | 关联日志上下文执行：withLogContext | `async()=>{ const started=performance.now(); logEvent('call.started',{level:'info'}); try{ const result=await execute(call_id); logEvent('call.…` | X016风险/结论；控制回调另见§5 |
| W-A001 | [L21](../../server/worker-pool.ts:21) | W018 createFairQueueHandler | 闭包适配/业务回调：returned/assigned callback | `async()=>{ for(let offset=0;offset<queues.length;offset++){ const index=(cursor+offset)%queues.length; if(await queues[index]!()){ cursor=(ind…` | W018风险/结论；控制回调另见§5 |
| W-A002 | [L36](../../server/worker-pool.ts:36) | W034 delay | Promise执行/收束：Promise | `resolve => { const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); }; const timer = setTimeout(f…` | W034风险/结论；控制回调另见§5 |
| W-A003 | [L58](../../server/worker-pool.ts:58) | W051 runWorkerPool | 构造/转换集合：Array.from | `async (_, worker) => { let previousFailure: string &#124; undefined; while (!options.signal.aborted) { let worked = false; let failed = false; try …` | W051风险/结论；控制回调另见§5 |
| W-A004 | [L69](../../server/worker-pool.ts:69) | W051 runWorkerPool | 关联日志上下文执行：withLogContext | `()=>runOne(worker)` | W051风险/结论；控制回调另见§5 |
| W-A005 | [L74](../../server/worker-pool.ts:74) | W051 runWorkerPool | 关联日志上下文执行：withLogContext | `()=>logEvent('worker.dispatch.failed',{level:'error',...classified})` | W051风险/结论；控制回调另见§5 |


### 用户选择保留原服务后的隔离验收尝试

用户明确选择保留 API PID34900 和 worker PID34830。两者未被停止或重启。

尝试复用已有远程材料任务归属，在本机回环3701临时启动加载v17的API（PID10508），没有新增产品接口、修改迁移或直接绕过API写库。只读检查：health返回schema ready；远程操作查询404证明表可查询；17道题目的API状态没有waiting/running attempt，监控亦为空。

向已有 `/api/remote-material-operations` 提交题目4的单独脱敏操作时返回500。安全日志关联 request_id `5fa60728-a70b-425e-a170-81ed21b4d440`：INSERT `ai_distill.remote_material_operations` 报数据库42703（未定义列），不是模型错误。健康检查只核对已登记迁移，不能证明实际表列与当前工作区一致。此次没有启动临时worker，没有调用模型；题目4／8真实验收仍缺失。不能在缺少数据库迁移授权时修补另一任务的表结构。

临时API已停止并删除临时认证文件；原有两个进程保留。当前阻碍已具体化为：现有服务不重启，隔离执行路径又存在schema漂移。须有可加载新代码的独立、契约一致执行环境后继续真实验收；165项测试不能替代该证据。


### 独立验收环境（用户要求自行启动）

保留原API34900和worker34830。采用临时回环3701 HTTP宿主：复用 `registerWorkflowExecutionRoutes` 的原单步派发及attempt查询处理器，通过已有dispatch注入点仅允许题目4／8的ordinal9，并调用生产 `enqueueRedaction(..., 'server')`。其他写操作拒绝；只读请求复用 `createApp`。专用一次性worker仅调用生产 `runNextRedaction` 的server队列，不运行远程操作、出题、评分、入库或提取；没有直接通过脚本写业务状态。这样避开无关远程编排表缺列，不迁移数据库、不修改原服务或生产接口。任务仍发布到原数据库两题的正常产物，符合先前真实测试授权。

验收按题4后题8顺序运行，避免两题各8路争抢同一个全局8路槽位；记录新attempt ID、v17冷启动、墙钟成功耗时及请求次数。临时宿主不是标准 `server/index.ts` 部署验收，但使用相同生产步骤路由、队列、脱敏执行器、API供应商和发布事务；明确保留此边界。


### 已执行真实测量与内容复查（尚未最终验收）

- 原有两个服务始终保留。最初server目标任务 `de4c6dbc-2919-4906-9c53-7ab78093512a` 被未加载新协议的其他worker领取，约0.5秒报protocol mismatch，未调用模型。为避免争抢，临时HTTP宿主随后复用既有 `ai_distill-dispatch` advisory锁，沿用生产enqueue与claim实现，短暂固定同一连接派发并领取local任务，领取提交后立即释放锁；未在整个模型处理期间占用全局调度锁。宿主不再经过远程编排表，不新增/迁移业务表。
- 题目4 v17 attempt `aed5e624-c5d1-4aa5-b0b0-342833b5d05c`：真实完整成功，4735/4735非空字段，22基础批次、29请求、7补做；2026-10-14 01:29:39.719Z—01:31:08.740Z，总89.021秒，执行器84.416秒。模型DeepSeek V4.1 Flash，8并发，v17全量冷启动。
- 题目4内容：1附件163页；源JSON与API当前原文相符；5102含空字段的结构位置全部保留，结构元数据差异0；1449字段改变。14处手机号、42处18位证件号格式均无完整残留。普通金额156个字段发生遮盖，与当前默认提示词“具体金额遮盖数字”一致，不代表本项目启用了保留金额。已知当事人姓名/组织候选检查中的一条所谓残留实际是庭审对白“清楚了”，不能把自动模式当作实体事实。原提取249条issues仍存在，不能宣称OCR无误。
- 真实内容复查发现：模型mask_text可能整段编号遮盖，从而违反首2末2规则；v18现由程序统一执行编号/案号规则，不让模型遮盖范围覆盖该规则。故v17题4成功不作为最终v18正确性验收。
- 题目8 v17 attempt `7d3cccbf-fd87-421d-a879-bc4a94a2580d`：25405/30508，140请求、25补做，执行317.793秒；任务01:31:58.940Z—01:38:16.385Z，总377.445秒，其中加载约59.5秒。失败reason为source_not_found，material acca1de7-3a51-4385-8620-e818a142fc24第34页b189-1；OCR在两个汉字之间夹入反斜线/波浪号。只允许汉字邻接的OCR符号间隙容错，数字标点仍严格区别；该例已先失败后回归通过。
- 同次排查还复现并修复了并发取消修改共享AbortSignal.reason导致原始call_id被最后调用覆盖；真实失败调用应为 `7d548d6e-1437-420b-8e47-9e5408fa230b`，旧summary错误显示另一个被取消的调用。
- 队列原文加载计入整题预算，读正文查询有180秒或剩余预算较小值的上限；执行器只收到剩余时间，发布前复核截止。此行为有失败在先的单测。
- 当前v18定向6文件测试169 pass、0 fail、489 assertions；类型检查通过。v18不复用v17断点，必须再次全量完成题目4／8，并以新产物审阅为最终证据；暂不宣称成功提速比例。


追加v18复测：题目4 attempt `5c2406d4-a1ac-4ae4-9c6c-16acb586fdd9` 于01:41:34.407Z—01:42:42.103Z失败，4277/4735、32请求、10补做。私有返回证明多字段返回借用了邻字段的地址/姓名；已有校验正确拒绝，但剩1—4字段没有第三步隔离、剩5—8字段没有拆分，造成可修复小组过早失败。现按原批次6次／整题额度：少量剩余字段各隔离一次，5—8字段也可缩批；初始就是单字段的请求不增加原样重试。两类新增测试先失败后通过。当前171 pass／0 fail／493 assertions，类型检查通过。

为测量全量冷启动，已把本轮v18题4的4277字段断点重命名为 `.verification-cold-backup`，保留内容而不加载；没有删除用户原件或旧协议断点。新派发将重新处理完整4735字段，最终报告不能把失败尝试的67.696秒或后续续跑冒充单次成功耗时。


最新状态：题4 v18 attempt3713ba33-617a-4697-82a8-2b30047f899c全量成功，4735/4735，30请求8补做，总110.568秒，执行105.680秒。内容回归又复现金额整段遮盖吞单位与组织整段遮盖吞组织形式；现对amount只遮数字、organization保留明确组织/法院后缀，173测试通过，类型检查通过。由于遮罩语义改变，协议升v19隔离旧映射，正在重新全量派发题8；题4仍需v19最终内容验收，不以v18成功替代。

### v19 日志复判与续跑（2026-10-14）

- 题8旧 attempt `7d3cccbf-fd87-421d-a879-bc4a94a2580d` 在01:31:58.940Z—01:38:16.385Z失败，25405/30508字段，140请求、25补做，总377.445秒。原始日志共814条；797条字段校验失败、8条调用失败。终态为 `redaction_source_not_found`；另有 `incomplete_finish_reason` 与并发收束的 `caller_cancelled`。用户可见输出只打印安全错误码、调用ID与计数，不打印材料原文。
- v19 attempt `f63f93b3-45a9-4e96-9c17-139f8d7122f3` 在02:38:04.531Z—02:41:39.680Z失败，11864/30508字段，86请求、23补做，墙钟213.291秒，队列累计40毫秒。终态 `redaction_request_timeout`。复查执行器发现单批错误会令首个worker立即 `controller.abort(error)`，从而取消其他7路并停止剩余批次；这把一个局部请求超时放大成整题提前失败。
- 修复后新增测试：一个字段单请求超时，其他批次仍完成并写入检查点；整题依然失败且不发布部分结果。认证／额度等全局服务错误仍立即停止后续派发。6个后端相关测试文件：175 pass／0 fail／502 assertions；`./node_modules/.bin/tsc --noEmit`通过，指定文件`git diff --check`通过。
- v19续跑 attempt `e21e3963-60b0-472b-bab0-4fb516a8ce5d` 在02:46:56.469Z—02:50:55.198Z失败，29996/30508字段、104请求、19补做，总238.729秒，队列累计68毫秒。2个单请求超时发生后，其他批次仍继续并保存；这一行为从真实调用日志得到验证。剩余512字段写入校验断点。结果仍失败，不可称为脱敏成功。
- 同输入新 attempt `6a19e008-5b96-4e18-a97a-8082d797c44d` 已创建，当前`waiting`。API监控显示原服务API PID17656、worker PID17759仍运行，worker心跳正常，但任务`waiting=1,running=0`。隔离worker明确阻塞在 `pg_advisory_xact_lock_shared(hashtext('ai_distill-dispatch'))`，因此尚不能从检查点继续。锁持有者未通过HTTP API暴露；没有直连数据库查询、没有停止PID17656／17759。
- 当前代码继续保持未通过的字段不能发布；真实题8全量成功、产物结构与敏感内容复核均未完成。题4只有v18全量成功记录，v19金额／组织遮罩变更尚未作真实复验。下一步须先解除派发锁阻塞，再续跑题8与题4 v19，分别验证全量完成、结构及内容边界；当前耗时是多attempt断点续跑，不可包装成单次冷启动速度。


### 2026-10-14 两个历史超时批次的真实 API 复跑

本轮任务：复跑题8断点中剩余的两组256字段；记录请求、HTTP响应阶段、输出完整性与生产校验；对已发现的漏字段做单一提示词改动对照；比较最终遮罩。验收以实际调用耗时、返回覆盖及原文定位为准，不将局部复跑作为题8全量发布验收。

执行边界：通过原3700 HTTP API读取当前项目配置与附件指纹，验证7份本地提取结果的source_sha256；没有直连数据库、重启现有服务、修改项目设置或写业务状态。复用当前生产脱敏执行器和API客户端，仅输入断点未完成字段，按原页序和原文保留；字段wire编号重新从f1开始，因此不是历史HTTP字节完全一致重放。诊断传输记录HTTP头、首个body及完整body时间，并显式使用生产本机请求槽位；超时仍180秒。原始请求/返回仅保存在700临时目录中的600私有文件，普通日志仅记安全元数据。

| 原规则复跑 | 原页 | 字段/字符 | API返回耗时 | 校验结果 | 上游供应商 |
| --- | --- | --- | --- | --- | --- |
| 附件bf7b…c2c9e首次 | 76–78 | 256/792 | 4.653秒 | 仅返回38字段，额外fields_omitted；218字段缺失 | Morph |
| 同组仅补缺失字段 | 同上 | 218/678 | 18.537秒 | 218字段全部通过；该组共23.227秒 | Parasail |
| 附件d251…f310 | 74–75 | 256/1470 | 16.088秒 | 256字段全部通过；该组共16.117秒 | DigitalOcean |

3次调用均HTTP200、finish_reason=stop，实际model均deepseek/deepseek-v4.1-flash，thinking=false；未复现180秒超时。基线合计512字段通过现有完整性/定位校验、3次真实调用、两组顺序处理共39.344秒。三次供应商不同是返回中的provider事实，不证明历史超时由供应商切换引起；历史失败未保存可定位的响应阶段，不能补造原先超时根因。

控制对照只在本次请求系统消息增加：必须返回全部target_id且每个恰好一次；无敏感也显式返回[]；禁止fields_omitted；source_text必须是未遮罩的原文。项目数据库提示词未改。两组均一次调用覆盖256字段并通过生产定位校验：792字符组Morph，API25.176秒、整组25.214秒；1470字符组DigitalOcean，API17.780秒、整组17.812秒。共2次真实调用、两组43.026秒；不可声称本轮对照提速，只能证明一次对照中消除了漏字段。

对照的HTTP头在1.295/1.507秒到达；最初body仅为保活空白，首个非空白JSON到达与返回完成在25.173/17.777秒。HTTP头或body字节增加不等于模型已输出有效脱敏内容。

内容复判：将两轮已收到的真实返回离线送入同一生产渲染器，无新增模型调用。最终遮罩有39处实际差异：792字符组3处编号/日期时间字符串一轮遮盖、另一轮保留；1470字符组34处重复组织名称的行业通称保留范围不同，另2处短数字处理不同（一个来自paragraph、一个来自table cell）。其中一轮保留组织名称中的行业通称，另一轮将其一并遮盖；前端JSON全覆盖/原文可定位不能证明没有扩大遮盖或漏识别。短字段输入不提供明确行列/页码上下文，短数字/时间字符串语义仍需结合原页确认，不能一律断言是编号。

用户展示的source_text为“张*”/“****元”属于已遮罩结果，而当前协议source_text要求原文敏感值；本次5次真实返回没有source_text含星号的条目。此格式差异与速度是不同问题。

证据：私有原规则复跑目录/private/tmp/ai-distill-redaction-replay-1791949223111；提示词对照目录/private/tmp/ai-distill-redaction-replay-1791949356374。目录内metrics.jsonl是安全耗时元数据，请求/响应和最终差异文件为受限私有材料，不复制到普通日志。两个临时执行进程均正常退出。真实题8全量发布、当前派发锁持有者与历史超时内部阶段仍未确认；当前工作流状态未通过这些局部诊断改变。


### 当前实施计划与验收（用户要求处理，2026-10-14）

任务：1. 修复局部请求超时缩批、子批失败收束和worker补位；2. 将接口Schema约束与完整字段覆盖绑定，并提供段落/表格行列及页级上下文；3. 固定经真实Schema验收的上游路由、修复隔离宿主的锁边界，定位已有派发锁；4. 针对性测试、真实题4/8全量运行并审阅组织行业通称、金额、编号、表格与页序。

验收：超时不原样再等、局部失败不损失并发、子批共享有限预算；模型返回缺字段仍拒绝、保留原文且不猜空结果；供应商选择与实际返回一致；锁等待有界、已有服务保留；题4/8必须全部字段完成并发布当前输入绑定产物，成功墙钟耗时和请求数分别报告，局部诊断不充当全流程验收。

已执行第一步：三个新增行为测试均先失败后通过，redaction-performance.test.ts 33 pass/0 fail。未将该测试结果当作真实题8完整成功。


### v20→v21 真实运行与语义复判（2026-10-14）

所有真实调用通过本地隔离 HTTP 宿主派发生产脱敏队列和消费者，限定题4/8；原 API/worker 保留。隔离宿主仅适配并行修改新增、当前数据库尚无的 workflow_kind/source_workflow_id 两处投影：这两道已知普通题目投影为 question/NULL，不迁移数据库、不改变材料绑定；这不是全站新版服务加载证明。原服务查询及产物下载仍走既有 HTTP API。

v20 自动路由题4完成4625/4735后失败：44请求、13补做；严格 Schema 已消除漏字段，DigitalOcean15调用中7次异常结束/截断，CoreWeave9调用未见外部失败。这是本轮配置选择的证据，不证明历史180秒超时原因。脱敏专用默认冻结CoreWeave、禁止回退；显式路由与普通作答不变。

v20 CoreWeave题4（bbe3708d-e4a6-492e-a1d9-b400a038fe49）全量成功：35.703秒、36请求、4735/4735。题8第一次规划发现5716字符单元格在上下文重复计入，未调用模型；改为共享目标引用，原文不截断。随后题8冷跑（28aa06af-7dbb-4b6c-97b1-17b8042f9763）167.446秒、243请求、30506/30508，两个字段无法定位，未发布；续跑（b2c5c737-13f1-4fa8-a7cd-b07878bb6319）4.074秒、2请求完成30508/30508。两次不能写成一次冷跑成功。

v20题8产物虽然结构校验通过，内容复判发现159处重复商户中145处行业通称被扩大遮盖，14处品牌未遮盖。v21用本题已定位组织/明确姓名映射统一重复便利店主体，保留行业后缀并拆出明确负责人；普通别名不能清空负责人集合。此规则不是全行业分类器，不推断未知括号内容，不跨题共享信息。

v21针对性测试：185 pass/0 fail、535断言，六个文件；TypeScript noEmit通过。新增行为测试先失败后通过。覆盖严格Schema、共享上下文、长单元格无重复输入、超时直接缩批、失败子批不丢兄弟结果、worker继续补位、预算边界、5秒锁争用回退、路由兼容和重复主体。测试不替代真实内容验收。

v21题4（f98f45dc-2caf-4a43-be58-eb45bd943603）04:44:16.679Z→04:44:47.056Z，墙钟30.377秒、36请求（30基础批次、6补做）、4735/4735并发布。私有QC重新核对来源摘要/完整文本，1附件163页5102结构位置，结构差异0；14处手机号均按首3末2遮盖，42处18位编号均按首2末2遮盖，完整号码剩余0。历史第135页整段编号分类差异本次未复现；这仍不能证明所有18位数字的语义分类或全文零漏识别。来源249条OCR issues保留。

当前v21题8真实冷跑attempt c73e471a-0ea4-4e7c-bc9e-391f2dc4c97a，须完成并复核行业/品牌/负责人及结构后才能宣布本轮全量验收结束。受限原始请求/响应位于/private/tmp/ai-distill-redaction-v21-coreweave-raw，不复制进普通日志或本报告。


v21追加验收没有一次冷跑成功：c73e471a-0ea4-4e7c-bc9e-391f2dc4c97a在156.158秒后失败，232请求、30506/30508，无超时；续跑1e7ea12c-a9d5-4215-b74e-53e31027d143为6.993秒、4请求、30507/30508。已加全题末轮至多4个单字段各一次定位修复，共享整题请求和时间预算，不能假成功。最后字段f9269来源是带反斜线转义的既有遮罩星号，模型返回字面星号；定位索引仅忽略星号前转义，不改原文、不容忍数字横线/小数点。修复后693565d5-41cc-4807-9dac-1a434765f50c续跑6.405秒、1请求，全量发布；这不能写成6秒处理全题。

v21复核7附件700页42724结构位置，结构差异0，来源摘要/文本7份一致，77手机号/118个18位编号无完整值剩余，1046条OCR问题保留。但160处重复商户中仍有10处行业通称丢失：响应把“商户(负责人)”整段标成name，叠加组织映射后整体遮盖。v22仅针对本题已明确组织/负责人精确组合跨类别规范化；不删除更长未知映射。相应回归先失败后通过。最终188项测试、545断言通过；整题时限测试改用精确推进墙钟避免毫秒定时抖动，取消/单次截止/停滞仍有实际定时测试。协议升级使历史成功结果不被误复用，必须重新冷跑题4/8。

官方设置核对：[Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)说明支持能力取决于实际上游端点、strict执行仍有差异，必须保留本地覆盖/定位检查；[Provider Selection](https://openrouter.ai/docs/guides/routing/provider-selection)提供固定only、禁用allow_fallbacks及require_parameters。CoreWeave的选择来自本轮真实失败/成功对照，不从官方文档推断所有供应商稳定性。180秒请求上限未提高；改善来自路由、严格输出、并行有界补位和局部修复，不把较长等待当提速。


### v22 最终冷跑验收结果

| 题目 | attempt_id | UTC开始→结束 | 墙钟 | 基础批次 | 实际请求/补做 | 完成 |
| --- | --- | --- | --- | --- | --- | --- |
| 4 | 1d31f3a9-cefb-435d-b995-79c0b15ff80b | 04:58:51.029→04:59:20.765 | 29.736秒 | 30 | 33/3 | 4735/4735，succeeded |
| 8 | a5e53ac3-4c59-47fd-b125-b17f8fd10e34 | 04:59:31.974→05:02:17.563 | 165.589秒 | 194 | 230/36 | 30508/30508，succeeded |

两题均新协议完整冷跑，无旧字段断点复用；没有手动续跑当作本次成功。执行阶段墙钟分别28.786/163.488秒；并发请求累计耗时196.199/1199.768秒不作为用户等待时长。263请求中261份实际返回上游CoreWeave，2次外部失败未返回供应商标识且有限补做恢复；最长完成或失败请求26.028秒，无180秒请求超时。原API PID17656和worker PID17759保留，新版只在隔离服务加载。

QC通过既有API下载本次产物并核对当前来源摘要及完整提取文本：题4为1附件163页5102结构位置，题8为7附件700页42724结构位置，页序/结构差异均0。来源OCR问题249/1046条保留，未把提取成功解释为全文识别准确。两题完整手机号模式14/77、18位数字模式42/118均无完整值剩余。

号码格式复判不能把正则模式当身份：题4有1处“乙方＋中文前缀＋18位数字”整段被判identifier，其数字并非有效身份证校验码，缺少足够语义证据确认它应独立按身份证保留首2末2，仍需人工确认；不以此放宽原文定位或虚报42/42身份证规则通过。题8手机号模式中1处实际是带字母前缀微信号，18位模式中1处是带下划线扩展的账号，按整段编号遮盖，属于模式统计不等于手机/身份证分类的边界。

题8此前失误的重复商户共160处：行业通称保留160/160、品牌完整值剩余0；其中150处含负责人完整姓名，均按姓＋**处理，完整姓名剩余0。此检查针对已知商户问题，未宣称全文语义零漏识别。其他敏感主体分类与OCR识别质量仍需业务审阅。

最终针对性测试188 pass/0 fail、545断言；TypeScript noEmit通过，相关diff检查通过。题8当前Markdown通过原API下载HTTP200，便于直接查看：/private/tmp/ai-distill-question8-v22-redacted.md（受限副本）。原始模型请求/响应/private/tmp/ai-distill-redaction-v22-coreweave-raw为私有诊断数据，不进入普通日志。


### v22 原文相似度与信息保留复审：发现过度遮盖

范围：题4当前1d31f3a9-cefb-435d-b995-79c0b15ff80b、题8当前a5e53ac3-4c59-47fd-b125-b17f8fd10e34；只读HTTP取得当前原文/产物，再匹配SHA与完整页文本一致的本地提取结构。本次未调用模型、未修改业务数据或执行测试。

| 项目 | 题4 | 题8 |
| --- | --- | --- |
| 附件/页 | 1/163 | 7/700 |
| 全量结构字段 | 5102 | 42724 |
| 完全未改字段 | 3789（74.265%） | 36391（85.177%） |
| 改动字段 | 1313 | 6333 |
| 原文/脱敏字符 | 68294/68106 | 339222/339558 |
| 原始字符相似度 | 79.179% | 85.817% |
| 删页、漏字段、结构差异 | 0 | 0 |
| 无法用星号遮盖解释的文字变化 | 0 | 0 |

相似度是逐字段SequenceMatcher（autojunk=false）匹配字符数汇总，公式2×匹配字符/(原文字符+脱敏字符)。不用于判断语义无损。额外逐字段检查输出非星号片段是否按原文顺序、边界存在；变化全部是遮罩形式，只证明没有另写正文，不能证明星号范围正确。姓名固定**导致字符长度变化正常。对PDF原件OCR准确性没有新增验证。

**复审结论：运行成功、结构完整，但内容存在已确认的过度遮盖，不能以此宣称无损脱敏。**

1. 题8至少10个字段遮盖案件业务日期，涉及货款归还、合同签订/终止、利息起算、判决/执行立案和发货时间。已逐条核对上下文；不把出生日期（个人信息）或水印时间列为这一结论。示例：附件20bb…2eea第48页b631-1，“终止时间为2018年3月27日”变为“终止时间为20******7日”；附件bf7b…c2c9e第67页b742-1，“发货日期:2018-02-08”连同“日期”标签被遮为星号。该损失可能影响案情时间线。
2. 金额单位在题4至少6个局部（5字段）、题8至少22个局部（19字段）连同数字被遮盖。逐差异片段确认，不将组织名中“元”字误计为货币单位。当前项目规则明确“遮盖数字，保留原文明确的币种和单位”，这些是规则违例；金额数字本身被遮盖则属于当前授权规则。示例：258610元整体变成七个星号；25万元整体变成四个星号。不能再沿用此前“单位无缺失”概括——此前号码/结构检查未覆盖这一语义边界。
3. 题8附件acca…fc24第54/55页的品牌面包名称全遮，导致酥皮面包/麻皮面包品类一起消失；应仅遮具体品牌，保留商品类别。
4. 题8附件bf7b…c2c9e第118页b911-1/caption，“3 月份[负责人]提货数量明细表”变成“3**”，姓名映射吞掉标题业务含义。
5. 主体行业/机构通称保留不普遍：律师事务所、汽车经纪、房地产仍有消失候选。题8附件03d2…0b4c第13页b130-1整段律师事务所名称被遮，机构通称也丢失。词频减少中也包含详细地址整体遮盖，不能把所有候选都算违规；应按映射与具体上下文复核。此前160处便利店统一只证明该已知形式正确，不能扩展到所有主体。

筛选边界：日期改动候选题4为14字段、题8为149字段，许多为水印/个人出生日期，不能全部当业务信息损失。题4另有5处银行凭证“时间戳”字段被当编号遮盖，相邻交易时间仍在；该时间戳是否需保留待业务确认。短数字变动1/77字段，含金额、车牌尾号、页码等不同语义，不能统一判错。本次是全量结构与字符检查及上述专项语义审阅，不是对47,826字段逐条人工认证。

受限逐差异对照：/private/tmp/ai-distill-redaction-information-loss-review.md；全量改动字段及原文/脱敏对照：/private/tmp/redaction-similarity-private-diffs.json；安全统计：/private/tmp/redaction-similarity-summary.json。原始私有材料不写普通日志。

后续修复应约束模型返回敏感主体的最小原文范围、核对类别与目标语义，在程序端保留金额单位及已确认行业/商品通称；增加本次案件日期、表标题、面包品类、金额单位真实反例。不能通过扩大模糊定位、补空结果或只提高字符相似度解决。修复后重新全量验收，本次审查不直接改代码/配置/结果。
