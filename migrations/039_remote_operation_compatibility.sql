-- 补齐早期已登记 034 的部署缺少的远程操作字段；保留全部现有记录。
ALTER TABLE ai_distill.remote_material_operations
 ADD COLUMN IF NOT EXISTS redaction_config_digest text,
 ADD COLUMN IF NOT EXISTS claim_token uuid;
