-- 文件职责：建立系统 Codex 凭证目录登记表；不保存凭证正文。
CREATE TABLE IF NOT EXISTS ai_distill.system_codex_config (
  id smallint PRIMARY KEY CHECK (id = 1),
  credential_home text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO ai_distill.system_codex_config(id, credential_home)
VALUES (1, NULL)
ON CONFLICT (id) DO NOTHING;
