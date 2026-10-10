<!-- 文件职责：保存 phase four independent modules 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# MVP 第四阶段独立模块交付

日期：2026-10-08。用户要求先实施可独立开发的任务，并由主 agent 保留数据库、状态流转、公共路由、worker接线及端到端验收。本轮交付第四阶段②国产模型适配器、⑥资源监控模块。

## 交付范围

| 模块 | 完成内容 | 主流程尚需接线 |
| --- | --- | --- |
| 国产模型适配器 | Kimi、DeepSeek、豆包纯文字非流式调用；固定结构接口、服务端密钥、显式模型、完整答案及原始usage、超时/取消、安全错误 | 项目模型集合配置、每模型答案记录、队列并发与版本绑定、结果齐备后判定 |
| 资源监控 | macOS内存估算、自己及明确登记子进程RSS、运行任务数量/状态、允许事件/认证/额度/错误分类、派发建议 | worker/Codex登记PID及事件、提供当前执行器状态、消费pause/unknown建议、监控查询和页面 |

本轮仅新增独立源码、后端测试、验证脚本与说明，不修改 app.ts、worker.ts、Codex/PDF实现、shared/types.ts、数据库、package.json、README、.env或前端。现有Qwen运行实现保持原样。

- 共用provider结构：`server/answer-models/provider.ts`，输入 `{config,question,materials,timeout_ms?,signal?}`，结果沿用QwenAnswer，错误沿用安全分类结构。
- 国产适配器：`server/answer-models/domestic.ts`。实际接口、配置变量与官方协议见 [国产模型说明](domestic-adapters.md)。不接OpenRouter、不自动切换端点、不透传未核对模式参数；不支持图片、工具与实际文件交付。
- 监控：`server/monitoring/resources.ts`。任务状态直接复用StepStatus；一次批量ps只取登记PID及当前进程的pid/rss，不读取命令行、环境或私有事件。不执行自动杀进程/取消/修改派发。详情见 [资源监控说明](resource-monitor.md)。

## 主线程复核

1. `bun test server/answer-models/domestic.test.ts server/monitoring/resources.test.ts server/answer-models/qwen.test.ts`：**274通过，0失败，614断言，3文件**。其中新增适配器136项、监控40项；既有Qwen回归98项。不是全仓测试。
2. `./node_modules/.bin/tsc --noEmit`：通过。另对两个独立模块、共用接口和验证脚本执行strict tsc通过。未安装依赖、未创建前端测试或启动开发服务。
3. `bun run scripts/verify-domestic-models.ts`：默认只做配置预检，三供应商缺少直连凭证和显式model，状态均unverified，request_attempted/called_provider均false。结果 [domestic-api-smoke-results.json](domestic-api-smoke-results.json)。不是一次真实模型调用。
4. `bun run scripts/verify-resource-monitor.ts`：真实本机采样，系统known、可用比例37%、对应估算14,302,241,095 bytes；当前采样进程RSS known 32,473,088 bytes。未提供真实执行器状态，因此任务状态与派发建议正确返回unknown，而非假定worker无任务或可以派发。结果 [resource-monitor-results.json](resource-monitor-results.json)。瞬时内存随时间变化，不能据此推出工作流长期稳定。

## 接入顺序

- 先用主流程已有题目/附件版本契约，为各供应商固定配置及允许的文字能力；复用同一允许输入包，禁止发送rubric、标答和私密映射。
- 对每模型单独存尝试、答案、原始usage、确切模型和配置；所有必需模型成功或有明确失败后再进入项目判定。不要用新增模块测试替代数据库/队列验收。
- 在执行器spawn/exit处登记/注销PID，投影安全事件及当前认证/额度状态；把现有step状态原样提供。历史错误何时清除、unknown是否暂停、阈值/作用范围由主流程资源策略决定。
- worker只根据资源建议控制新派发，不杀正常任务；需要取消/恢复时沿用具体执行器能力和版本保护。模块只返回建议，没有实现暂停状态或恢复机制。

## 真正未完成的部分

- 三供应商真实API：当前没有各供应商的直连普通凭证与模型配置；已有OpenRouter配置不能用于本模块直连。提供配置后，可运行 `bun scripts/verify-domestic-models.ts --call kimi`（或deepseek/doubao），每次仅发送一题合成文字请求，不使用卷宗。默认预检不计费；显式--call会调用供应商API。
- 第四阶段多模型业务接线、自动推进、有限返修、资源暂停恢复及界面均未验收；本轮不能标记整个第四阶段完成。
- Excel导出等待主流程固定成果字段；项目skill生成属于第三阶段，本轮未实施。
