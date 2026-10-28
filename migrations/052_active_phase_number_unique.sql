-- 文件职责：只约束当前可见期次的期号唯一；允许已删除期次的编号被重新创建。
-- 执行影响：重建期号唯一索引，不修改任何项目或工作流数据。
DROP INDEX ai_distill.projects_group_phase_no;
CREATE UNIQUE INDEX projects_group_phase_no
 ON ai_distill.projects(project_group_id,phase_no)
 WHERE phase_no IS NOT NULL AND deleted_at IS NULL;
