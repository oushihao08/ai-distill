-- 按成功提取任务和快速评估版本保存合并DOCX估算页数；历史加载关系不回写。
CREATE TABLE ai_distill.library_load_eligibility (
  revision_id uuid NOT NULL REFERENCES ai_distill.library_revisions(id) ON DELETE RESTRICT,
  extraction_job_id uuid NOT NULL,
  source_digest text NOT NULL CHECK (length(source_digest)>0),
  assessment_version text NOT NULL CHECK (length(assessment_version)>0),
  estimated_page_count integer NOT NULL CHECK (estimated_page_count>0),
  load_eligible boolean GENERATED ALWAYS AS (estimated_page_count>10) STORED,
  measured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (revision_id,extraction_job_id,assessment_version),
  CONSTRAINT library_load_eligibility_source_fk FOREIGN KEY (revision_id,extraction_job_id)
   REFERENCES ai_distill.library_jobs(revision_id,id) ON DELETE RESTRICT
);
