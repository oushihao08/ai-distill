# API 脱敏设置运行修复

2026-10-09，针对页面保存时报“此步骤使用codex”的实际故障。

- 运行中的 API/worker 早于独立 API 接入；旧 API 拒绝脱敏 API 配置。更新两项本地服务后，统一模型接口返回 200。
- 随后项目详情出现 500，安全日志数据库错误码为 `42703`。只读 schema 核对确认 materials 缺少 deleted_at，仍保留 input_revision。
- 沿用此前用户要求数据库、后端、前端移除材料版本的范围，停止服务后，在当前工作台连接数据库事务内只应用并登记 `027_remove_material_versions.sql`；未运行全量迁移、024 或 026。
- 迁移保留原件、提取文本、执行历史；移除版本字段，使旧脱敏及后续当前结果失效。提交成功后恢复 API/worker。
- 为当前“豆包高经济价值 · 第五期”保存 API 脱敏配置，保持原提示词，采用统一默认 OpenRouter `z-ai/glm-5.3-flash`。实际 PUT 返回 200，随后 GET 项目详情返回 200，并读回 provider=api 和上述模型。worker monitor 为 running，脱敏 waiting/running 队列均为 0。

本次证据证明配置保存和项目读取恢复，不证明真实模型调用、脱敏准确性或浏览器保存操作验收。没有派发模型任务，没有运行测试或 lint。
