<!-- 文件职责：保存 phase four wiring 的历史证据与检查记录；结论仅限文件注明的日期和范围。 -->
# 第四阶段接线验收

2026-10-08，用户授权执行后完成公共接线。

- 第五步配置/API/worker统一provider分派；Qwen原有端点和配置兼容，Kimi、DeepSeek、豆包沿用自己的凭证与显式模型。页面可选择供应商，仅Qwen显示思考参数。
- 作答任务保存固定provider/config、完整答案/usage、模式与版本关系；原生错误复用安全错误结构，晚到结果隔离与下载仍沿用现有机制。
- 两个worker池领取前使用同一个监控gate。默认可用内存阈值10%，可由WORKER_MIN_AVAILABLE_PERCENT调整；每5秒采样，低内存停止新领取，恢复继续，正在运行任务不取消。读取未知明确记录并沿用既有派发策略。
- 原子写入私有.storage/.worker-monitor.json；只读GET /api/monitor严格重建字段并返回no-store；项目列表5秒刷新，过期/不可用不展示为当前正常数据。

验证：327项相关后端单元测试通过，前后端类型检查通过；scripts/verify-answer-flow.ts使用真实PostgreSQL隔离临时schema、合成题目与注入provider，检查三家配置/队列/持久化，以及监控暂停、恢复、停止接口。结果见answer-flow-results.json。临时schema与文件清理，不调用真实供应商。

未完成：真实三家模型API（缺少原生密钥和显式model）；Qwen真实调用此前因OpenRouter管理密钥被401拒绝，需普通调用密钥；浏览器页面操作验收及实际运行worker重启验收。一个项目每次仍选一个模型，不含同题多模型齐备聚合、自动评分/达标、自动返修、Excel导出。监控只采集本地worker进程、当前材料版本的数据库任务及心跳，子进程/认证/额度/错误状态尚未连接；不代表完整第四阶段完成。
