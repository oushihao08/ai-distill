-- 文件职责：将 PDF 提取并入可见入库状态，保留内部 ordinal 2 与独立脱敏。
-- The logical first stage now includes PDF text extraction before raw text is
-- considered ready for the separate redaction stage. Keep ordinal 2 as an
-- internal extraction attempt identity for existing history and worker queues.
UPDATE ai_distill.steps
SET name = '入库（含PDF文本提取）', display_position = 1
WHERE ordinal = 1;

UPDATE ai_distill.steps
SET name = 'PDF文本提取', display_position = 99, enabled = false
WHERE ordinal = 2;

UPDATE ai_distill.steps extraction
SET status = 'skipped',
    result = '{"reason":"没有PDF，无需单独OCR"}'::jsonb,
    error = NULL,
    finished_at = now()
FROM ai_distill.workflows w
WHERE extraction.workflow_id = w.id
  AND extraction.ordinal = 2
  AND NOT EXISTS (
    SELECT 1 FROM ai_distill.materials m
    WHERE m.workflow_id = w.id AND m.input_revision = w.input_revision
      AND lower(m.original_name) LIKE '%.pdf'
  );

UPDATE ai_distill.steps
SET display_position = CASE
  WHEN ordinal = 9 THEN 2
  WHEN ordinal BETWEEN 3 AND 8 THEN ordinal
  ELSE display_position
END
WHERE ordinal BETWEEN 3 AND 9;

UPDATE ai_distill.steps ingestion
SET status = extraction.status,
    result = extraction.result,
    error = extraction.error,
    started_at = extraction.started_at,
    finished_at = extraction.finished_at
FROM ai_distill.steps extraction
JOIN ai_distill.workflows w ON w.id = extraction.workflow_id
WHERE ingestion.workflow_id = extraction.workflow_id
  AND ingestion.ordinal = 1
  AND extraction.ordinal = 2
  AND EXISTS (
    SELECT 1 FROM ai_distill.materials m
    WHERE m.workflow_id = w.id AND m.input_revision = w.input_revision
      AND lower(m.original_name) LIKE '%.pdf'
  );

UPDATE ai_distill.project_workflow_steps
SET position = 99, enabled = false
WHERE step_key = 'extract_text';

UPDATE ai_distill.project_workflow_steps
SET position = CASE
  WHEN step_key = 'redact_materials' THEN 2
  WHEN step_key = 'load_rules' THEN 3
  WHEN step_key = 'author_quality' THEN 4
  WHEN step_key = 'model_answer' THEN 5
  WHEN step_key = 'independent_score' THEN 6
  WHEN step_key = 'accept_or_revise' THEN 7
  WHEN step_key = 'publish_export' THEN 8
  ELSE position
END
WHERE step_key IN ('redact_materials','load_rules','author_quality','model_answer','independent_score','accept_or_revise','publish_export');
