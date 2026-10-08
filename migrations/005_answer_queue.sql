UPDATE ai_distill.steps SET implemented=true WHERE ordinal=5;
CREATE INDEX answer_attempts_pending ON ai_distill.step_attempts(status,started_at) WHERE ordinal=5;
