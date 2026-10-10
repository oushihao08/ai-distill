-- 文件职责：启用达标判定，建立 API 价格表与项目导出记录。
UPDATE ai_distill.steps SET implemented=true WHERE ordinal=7;
CREATE TABLE ai_distill.api_model_prices (
 id uuid PRIMARY KEY,
 provider text NOT NULL,
 model text NOT NULL,
 currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
 input_per_million numeric(20,10) NOT NULL CHECK (input_per_million>=0),
 output_per_million numeric(20,10) NOT NULL CHECK (output_per_million>=0),
 cached_input_per_million numeric(20,10) CHECK (cached_input_per_million>=0),
 cache_write_per_million numeric(20,10) CHECK (cache_write_per_million>=0),
 source text NOT NULL CHECK (length(source) BETWEEN 1 AND 500),
 valid_from timestamptz NOT NULL,
 valid_until timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK (valid_until IS NULL OR valid_until>valid_from),
 UNIQUE(provider,model,currency,valid_from)
);
CREATE INDEX api_model_prices_lookup ON ai_distill.api_model_prices(provider,model,valid_from DESC);
CREATE TABLE ai_distill.project_exports (
 id uuid PRIMARY KEY,
 project_id uuid NOT NULL REFERENCES ai_distill.projects(id),
 batch text,
 status text NOT NULL CHECK(status IN ('running','succeeded','failed','stale')),
 storage_path text,
 sha256 text,
 workflow_count integer NOT NULL DEFAULT 0 CHECK(workflow_count>=0),
 workflow_ids uuid[] NOT NULL DEFAULT '{}',
 workflow_revisions jsonb NOT NULL DEFAULT '{}',
 error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz,
 CHECK(status<>'succeeded' OR (storage_path IS NOT NULL AND sha256 ~ '^[a-f0-9]{64}$'))
);
CREATE INDEX project_exports_history ON ai_distill.project_exports(project_id,created_at DESC);
