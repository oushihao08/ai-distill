-- 文件职责：为项目导出状态补充输入变化后的 stale 标记兼容。
ALTER TABLE ai_distill.project_exports DROP CONSTRAINT project_exports_status_check;
ALTER TABLE ai_distill.project_exports ADD CONSTRAINT project_exports_status_check CHECK(status IN ('running','succeeded','failed','stale'));
