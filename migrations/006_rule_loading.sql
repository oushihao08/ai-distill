-- 文件职责：启用历史规则绑定步骤；可见步骤布局由后续注册表与迁移决定。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=3;
