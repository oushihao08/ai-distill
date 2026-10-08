UPDATE ai_distill.steps SET implemented=true WHERE ordinal=4;
CREATE INDEX authoring_attempts_pending ON ai_distill.step_attempts(status,started_at) WHERE ordinal=4 AND status IN ('waiting','running');
