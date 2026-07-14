-- ─────────────────────────────────────────────────────────────
--  Schema v2 — Projects, Competitors, Tracking
--  Run: psql $DATABASE_URL -f lib/db/schema-v2.sql
-- ─────────────────────────────────────────────────────────────

-- ── Projects (client + site config) ──────────────────────────
CREATE TABLE IF NOT EXISTS projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_name     TEXT NOT NULL,
  website_url     TEXT NOT NULL,
  scope_prefix    TEXT,
  max_pages       INTEGER NOT NULL DEFAULT 100,
  auth_config     JSONB,
  weights         JSONB NOT NULL DEFAULT '{}',
  -- How the client's URL set is built for each run:
  --   'domain' → crawl/discover the whole site (default, legacy behaviour)
  --   'single' → audit exactly one page (website_url)
  --   'list'   → audit an explicit set of URLs (source_urls)
  audit_source    TEXT NOT NULL DEFAULT 'domain'
                  CHECK (audit_source IN ('domain','single','list')),
  -- Explicit URL list for audit_source = 'list' (JSON array of strings)
  source_urls     JSONB,
  -- Cached from latest completed run
  latest_score    SMALLINT,
  latest_grade    CHAR(1),
  score_delta     REAL,           -- change vs previous run
  last_audited_at TIMESTAMPTZ,
  run_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_created ON projects(created_at DESC);

-- ── Patch existing projects tables (idempotent) ───────────────
-- For databases created before audit_source / source_urls existed.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS audit_source TEXT NOT NULL DEFAULT 'domain';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS source_urls  JSONB;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'projects' AND constraint_name = 'projects_audit_source_check'
  ) THEN
    ALTER TABLE projects
      ADD CONSTRAINT projects_audit_source_check
      CHECK (audit_source IN ('domain','single','list'));
  END IF;
END$$;

DROP TRIGGER IF EXISTS projects_updated_at ON projects;
CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Competitor configs (sites to track alongside client) ──────
CREATE TABLE IF NOT EXISTS competitor_configs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  scope_prefix    TEXT,
  -- Color index 0-4 for chart color assignment
  color_index     SMALLINT NOT NULL DEFAULT 0,
  -- Cached from latest run
  latest_score    SMALLINT,
  latest_grade    CHAR(1),
  score_delta     REAL,
  last_audited_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_competitors_project ON competitor_configs(project_id);

-- ── Patch audit_jobs to link to projects ─────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='audit_jobs' AND column_name='project_id'
  ) THEN
    ALTER TABLE audit_jobs ADD COLUMN project_id UUID REFERENCES projects(id);
    ALTER TABLE audit_jobs ADD COLUMN competitor_id UUID REFERENCES competitor_configs(id);
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_audit_jobs_project ON audit_jobs(project_id);
CREATE INDEX IF NOT EXISTS idx_audit_jobs_competitor ON audit_jobs(competitor_id);

-- ── Score history view (for trend charts) ────────────────────
CREATE OR REPLACE VIEW project_score_history AS
SELECT
  j.project_id,
  j.competitor_id,
  j.id              AS job_id,
  j.completed_at    AS run_at,
  ROUND(AVG(ps.overall_score))           AS avg_score,
  ROUND(AVG(ps.score_core_intent))       AS avg_core_intent,
  ROUND(AVG(ps.score_edge_cases))        AS avg_edge_cases,
  ROUND(AVG(ps.score_implied_questions)) AS avg_implied_questions,
  ROUND(AVG(ps.score_fan_out_queries))   AS avg_fan_out_queries,
  ROUND(AVG(ps.score_retrievable))       AS avg_retrievable,
  ROUND(AVG(ps.score_extractable))       AS avg_extractable,
  ROUND(AVG(ps.score_citable))           AS avg_citable,
  ROUND(AVG(ps.score_reusable))          AS avg_reusable,
  COUNT(ps.id)                           AS pages_scored
FROM audit_jobs j
JOIN page_scores ps ON ps.job_id = j.id
WHERE j.status = 'done' AND j.project_id IS NOT NULL
GROUP BY j.project_id, j.competitor_id, j.id, j.completed_at
ORDER BY j.completed_at ASC;
