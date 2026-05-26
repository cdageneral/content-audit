-- ─────────────────────────────────────────────────────────────
--  AI Content Audit Agent — Neon Postgres Schema
--  Run once: psql $DATABASE_URL -f lib/db/schema.sql
-- ─────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Auth configs (stored encrypted via app layer) ─────────────
CREATE TABLE IF NOT EXISTS auth_configs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('none', 'cookie', 'bearer', 'basic')),
  -- Encrypted JSON blob containing the actual credentials
  payload     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Audit jobs ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  url             TEXT NOT NULL,
  scope_prefix    TEXT,
  auth_config_id  UUID REFERENCES auth_configs(id),
  max_pages       INTEGER NOT NULL DEFAULT 500,
  -- JSONB weights for each scoring dimension
  weights         JSONB NOT NULL DEFAULT '{}',
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','discovering','crawling','scoring','done','failed')),
  total_pages     INTEGER NOT NULL DEFAULT 0,
  crawled_pages   INTEGER NOT NULL DEFAULT 0,
  scored_pages    INTEGER NOT NULL DEFAULT 0,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_audit_jobs_status ON audit_jobs(status);
CREATE INDEX IF NOT EXISTS idx_audit_jobs_created ON audit_jobs(created_at DESC);

-- ── Crawled pages ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_pages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              UUID NOT NULL REFERENCES audit_jobs(id) ON DELETE CASCADE,
  url                 TEXT NOT NULL,
  title               TEXT,
  meta_description    TEXT,
  -- Stored in Vercel Blob; this is just the blob key
  body_text_blob_key  TEXT,
  -- Inline for pages < 64kb, otherwise use blob
  body_text           TEXT,
  word_count          INTEGER NOT NULL DEFAULT 0,
  headings            JSONB NOT NULL DEFAULT '[]',
  internal_links      JSONB NOT NULL DEFAULT '[]',
  external_links      JSONB NOT NULL DEFAULT '[]',
  metadata            JSONB NOT NULL DEFAULT '{}',
  http_status         INTEGER NOT NULL DEFAULT 200,
  crawled_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, url)
);

CREATE INDEX IF NOT EXISTS idx_audit_pages_job ON audit_pages(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_pages_url  ON audit_pages(url);

-- ── Page scores ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS page_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id         UUID NOT NULL REFERENCES audit_pages(id) ON DELETE CASCADE,
  job_id          UUID NOT NULL REFERENCES audit_jobs(id) ON DELETE CASCADE,
  -- Individual dimension scores (0–100 each)
  score_core_intent       SMALLINT NOT NULL DEFAULT 0,
  score_edge_cases        SMALLINT NOT NULL DEFAULT 0,
  score_implied_questions SMALLINT NOT NULL DEFAULT 0,
  score_fan_out_queries   SMALLINT NOT NULL DEFAULT 0,
  score_retrievable       SMALLINT NOT NULL DEFAULT 0,
  score_extractable       SMALLINT NOT NULL DEFAULT 0,
  score_citable           SMALLINT NOT NULL DEFAULT 0,
  score_reusable          SMALLINT NOT NULL DEFAULT 0,
  -- Rationale per dimension
  rationale       JSONB NOT NULL DEFAULT '{}',
  -- Weighted overall
  overall_score   SMALLINT NOT NULL DEFAULT 0,
  grade           CHAR(1) NOT NULL DEFAULT 'F',
  recommendations JSONB NOT NULL DEFAULT '[]',
  model_version   TEXT NOT NULL,
  scored_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_page_scores_job    ON page_scores(job_id);
CREATE INDEX IF NOT EXISTS idx_page_scores_page   ON page_scores(page_id);
CREATE INDEX IF NOT EXISTS idx_page_scores_overall ON page_scores(overall_score DESC);

-- ── Trigger: auto-update updated_at on audit_jobs ─────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_jobs_updated_at ON audit_jobs;
CREATE TRIGGER audit_jobs_updated_at
  BEFORE UPDATE ON audit_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Helpful view: job summary with scores ─────────────────────
CREATE OR REPLACE VIEW job_summary AS
SELECT
  j.id,
  j.url,
  j.scope_prefix,
  j.status,
  j.total_pages,
  j.crawled_pages,
  j.scored_pages,
  j.created_at,
  j.completed_at,
  ROUND(AVG(ps.overall_score))          AS avg_score,
  ROUND(AVG(ps.score_core_intent))      AS avg_core_intent,
  ROUND(AVG(ps.score_edge_cases))       AS avg_edge_cases,
  ROUND(AVG(ps.score_implied_questions)) AS avg_implied_questions,
  ROUND(AVG(ps.score_fan_out_queries))  AS avg_fan_out_queries,
  ROUND(AVG(ps.score_retrievable))      AS avg_retrievable,
  ROUND(AVG(ps.score_extractable))      AS avg_extractable,
  ROUND(AVG(ps.score_citable))          AS avg_citable,
  ROUND(AVG(ps.score_reusable))         AS avg_reusable
FROM audit_jobs j
LEFT JOIN page_scores ps ON ps.job_id = j.id
GROUP BY j.id;
