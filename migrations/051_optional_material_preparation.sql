-- 可跳过的一次Agent材料整理；复用库任务和队列，仅新增结果表，不回填或拦截已有流程。
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT library_jobs_kind_check;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_kind_check CHECK(kind IN ('intake','extract','redact','prepare'));
ALTER TABLE ai_distill.library_jobs DROP CONSTRAINT library_jobs_executor_kind;
ALTER TABLE ai_distill.library_jobs ADD CONSTRAINT library_jobs_executor_kind CHECK (
 (kind='intake' AND executor_kind='internal') OR
 (kind='extract' AND executor_kind IN ('internal','api')) OR
 (kind='redact' AND executor_kind IN ('internal','api','agent')) OR
 (kind='prepare' AND executor_kind='agent' AND execution_target='local')
);
DROP INDEX ai_distill.library_jobs_one_active_per_revision;
CREATE UNIQUE INDEX library_jobs_one_active_per_revision ON ai_distill.library_jobs(revision_id)
 WHERE status IN ('queued','running') AND kind<>'prepare';
CREATE TABLE ai_distill.library_preparations (
 id uuid PRIMARY KEY,
 job_id uuid NOT NULL UNIQUE REFERENCES ai_distill.library_jobs(id) ON DELETE RESTRICT,
 package_id uuid NOT NULL,
 revision_id uuid NOT NULL,
 extraction_job_id uuid NOT NULL,
 redaction_id uuid,
 project_id uuid REFERENCES ai_distill.projects(id) ON DELETE SET NULL,
 source_digest text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(package_id,revision_id) REFERENCES ai_distill.library_revisions(package_id,id),
 FOREIGN KEY(revision_id,extraction_job_id) REFERENCES ai_distill.library_jobs(revision_id,id),
 FOREIGN KEY(revision_id,redaction_id) REFERENCES ai_distill.library_redactions(revision_id,id)
);
CREATE INDEX library_preparations_source ON ai_distill.library_preparations(package_id,revision_id,redaction_id,created_at DESC);
-- 输入和结果依靠已有任务/库不可变记录绑定；结果无内容准入、有效期或强制重做标记。
