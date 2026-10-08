CREATE TABLE ai_distill.revision_chains (
 id uuid PRIMARY KEY,
 workflow_id uuid NOT NULL REFERENCES ai_distill.workflows(id),
 input_revision integer NOT NULL CHECK (input_revision > 0),
 source_attempt_id uuid NOT NULL REFERENCES ai_distill.step_attempts(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','blocked','accepted','isolated','stale')),
 budget jsonb NOT NULL,
 config_snapshot jsonb NOT NULL DEFAULT '{}',
 content_revisions integer NOT NULL DEFAULT 0 CHECK (content_revisions >= 0),
 technical_retries integer NOT NULL DEFAULT 0 CHECK (technical_retries >= 0),
 calls_reserved integer NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
 spent_duration_ms bigint NOT NULL DEFAULT 0 CHECK (spent_duration_ms >= 0),
 reason text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(workflow_id,source_attempt_id)
);
CREATE UNIQUE INDEX revision_chains_one_active ON ai_distill.revision_chains(workflow_id)
 WHERE status IN ('waiting','running','blocked');

CREATE TABLE ai_distill.revision_rounds (
 id uuid PRIMARY KEY,
 chain_id uuid NOT NULL REFERENCES ai_distill.revision_chains(id) ON DELETE CASCADE,
 round integer NOT NULL CHECK (round > 0),
 parent_round_id uuid REFERENCES ai_distill.revision_rounds(id),
 source_attempt_id uuid NOT NULL REFERENCES ai_distill.step_attempts(id) ON DELETE CASCADE,
 issue_kind text NOT NULL CHECK (issue_kind IN ('service_transient','authentication','quota','question','rubric','material','score','rules','unknown')),
 evidence jsonb NOT NULL,
 decision jsonb NOT NULL,
 stage integer CHECK (stage IN (2,4,5,6,7)),
 status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','running','blocked','succeeded','failed','isolated','stale')),
 before_versions jsonb NOT NULL DEFAULT '{}',
 after_versions jsonb,
 before_scores jsonb NOT NULL DEFAULT '{}',
 after_scores jsonb,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(chain_id,round),
 UNIQUE(chain_id,source_attempt_id)
);

-- Reserve each real external invocation before sending it. An uncertain result
-- remains reserved; it is never silently refunded after a worker restart.
CREATE TABLE ai_distill.revision_calls (
 id uuid PRIMARY KEY,
 chain_id uuid NOT NULL REFERENCES ai_distill.revision_chains(id) ON DELETE CASCADE,
 round_id uuid NOT NULL REFERENCES ai_distill.revision_rounds(id) ON DELETE CASCADE,
 attempt_id uuid NOT NULL REFERENCES ai_distill.step_attempts(id) ON DELETE CASCADE,
 call_key text NOT NULL,
 status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','completed','failed','unknown')),
 usage jsonb,
 duration_ms bigint CHECK (duration_ms >= 0),
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 UNIQUE(chain_id,attempt_id,call_key)
);

ALTER TABLE ai_distill.step_attempts ADD COLUMN revision_round_id uuid REFERENCES ai_distill.revision_rounds(id) ON DELETE SET NULL;
CREATE INDEX revision_attempts_round ON ai_distill.step_attempts(revision_round_id) WHERE revision_round_id IS NOT NULL;
