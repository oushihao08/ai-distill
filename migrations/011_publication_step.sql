-- 文件职责：启用正式成果发布步骤；实际发布校验由 publishing 模块执行。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=8;
