-- 文件职责：移除当前流程不再使用的价格目录和项目步骤模板表。
-- 数据库复核：api_model_prices 与 project_workflow_steps 均无当前代码读写；
-- 价格目录为空，步骤模板已由稳定步骤注册表取代。保留历史迁移文件不变。
DROP TABLE IF EXISTS ai_distill.api_model_prices;
DROP TABLE IF EXISTS ai_distill.project_workflow_steps;
