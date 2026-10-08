CREATE TABLE ai_distill.system_answer_models (
 id uuid PRIMARY KEY,
 name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
 provider text NOT NULL CHECK (provider IN ('qwen','kimi','deepseek','doubao')),
 base_url text NOT NULL,
 model text NOT NULL,
 enabled boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,base_url,model)
);

CREATE TABLE ai_distill.project_answer_models (
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id) ON DELETE CASCADE,
 model_id uuid NOT NULL REFERENCES ai_distill.system_answer_models(id),
 minimum_score numeric NOT NULL CHECK (minimum_score >= 0),
 position integer NOT NULL CHECK (position BETWEEN 0 AND 7),
 PRIMARY KEY(project_id,model_id),
 UNIQUE(project_id,position)
);
