ALTER TABLE ai_distill.project_exports DROP CONSTRAINT project_exports_status_check;
ALTER TABLE ai_distill.project_exports ADD CONSTRAINT project_exports_status_check CHECK(status IN ('running','succeeded','failed','stale'));
