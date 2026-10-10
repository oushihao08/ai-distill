<!-- 文件职责：保存 answer input and score validation 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# F47、第五步接线与 F49 交付

日期：2026-10-08。依据：用户同意实施作答输入包、第五步配置/队列/结果留存、评分证据/总分/版本校验。

## 已实现

| 范围 | 结果 |
| --- | --- |
| F47 | 从同版本成功第四步选择正式题面、成功第二步脱敏文本；文件边界、指纹和能力检查；保存明确输入快照；不选 rubric/标答/目标分数/私有文件 |
| F42 第五步配置 | 现有 project_step_configs 保存 Qwen 端点、模型和可选参数；页面编辑；凭证只在服务端；任务配置固定 |
| F43 第五步执行部分 | 单条/批量入队、并发去重、worker领取/心跳失联恢复、答案/用量/时间/版本入库、答案文件下载、安全失败及迟到隔离 |
| F49 程序校验 | 绑定当前题目、附件快照、rubric及完整答案；条目/分值/逐字证据/有效性/争议/总分检查；读取持久化上下文的校验API |

核心实现：server/answer-models/input.ts、jobs.ts、server/scoring/validate.ts、context.ts。公共接线：server/project-folders.ts、app.ts、worker.ts、intake.ts、shared/types.ts、StepSettings.vue、WorkflowDetail.vue。没有修改 PDF/Codex 实现、package.json 或全局样式，保留另一智能体的并行改动。

生产者契约：[第四、五、六步产物契约](../plans/2026-10-08-answer-input-and-score-contract.md)。

## 本次验证

- `bun test server/answer-models server/scoring server/project-folders.test.ts server/routes.test.ts server/app.test.ts server/worker-pool.test.ts`：196通过、0失败、544断言、8文件。覆盖原Qwen98项和新增输入/队列/评分行为及受影响路由/上传/配置/worker回归；不是全仓测试。
- `./node_modules/.bin/tsc --noEmit`：通过。
- `./web/node_modules/.bin/vue-tsc --noEmit -p web/tsconfig.json`：通过。未创建前端测试、未启动开发服务、未做浏览器验收。
- `bun run scripts/verify-answer-flow.ts`：隔离 PostgreSQL schema 的13条检查通过，临时schema与文件清理完成。验证真实数据库事务、并发入队、配置API、输入边界、答案入库/下载、评分校验、题目变更与文件清理。第四步结果为合成夹具，Qwen提供商为注入函数，没有调用真实推理API。原始结果：[answer-flow-results.json](answer-flow-results.json)。

## 接通与验收边界

1. 真实Qwen请求：现有OPEN_ROUTER_KEY已确认是管理密钥，先前真实推理返回401；本次没有重复请求，也没有创建/变更外部密钥。需要可推理的普通密钥，证据见 qwen-api-smoke-results.json。
2. 第四步真实题目生产者及第六步独立评分执行器尚未接通；F49只检查程序可核验条件，不证明评分语义、官方资格、难度或八步完整闭环。校验接口不保存原始评分、不标记第六步成功，评分执行器须留存原始评分和校验结果。
3. 当前客户端不支持图片输入、工具调用及模型实际文件交付，能力要求缺失或不符合时明确阻断。不能用文字答案代替要求Word等文件的测评。
4. `bun run server/migrate.ts`已在当前配置业务库成功应用005_answer_queue.sql，补充第五步可用标记和队列索引；未修改题目、材料或答案内容。
5. 单worker内Qwen4通道共享于所有项目；材料处理2通道独立保留。多个worker进程的合计限流以及自动技术重试尚未实现。

## 实施时修正

- 新增作答执行器后，既有上传测试仍断言只有第一/二步implemented，更新断言允许第五步。
- 第五步按钮的模板表达式最初使用HTML实体导致vue-tsc解析错误，已修正并重新通过类型检查。
- 补充显式文字/工具能力声明，阻止无法完成实际文件交付的任务被当成成功试答。
