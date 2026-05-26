import { neon } from "@neondatabase/serverless";
import type { DimensionScores } from "@/lib/types";
import { DEFAULT_WEIGHTS } from "@/lib/types";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  return neon(process.env.DATABASE_URL);
}

// ── Types ─────────────────────────────────────────────────────

export interface Project {
  id: string;
  clientName: string;
  websiteUrl: string;
  scopePrefix: string | null;
  maxPages: number;
  authConfig: Record<string, unknown> | null;
  weights: DimensionScores;
  latestScore: number | null;
  latestGrade: string | null;
  scoreDelta: number | null;
  lastAuditedAt: Date | null;
  runCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface CompetitorConfig {
  id: string;
  projectId: string;
  name: string;
  url: string;
  scopePrefix: string | null;
  colorIndex: number;
  latestScore: number | null;
  latestGrade: string | null;
  scoreDelta: number | null;
  lastAuditedAt: Date | null;
  createdAt: Date;
}

export interface ProjectCreate {
  clientName: string;
  websiteUrl: string;
  scopePrefix?: string;
  maxPages?: number;
  authConfig?: Record<string, unknown>;
  weights?: Partial<DimensionScores>;
}

export interface ScoreHistoryPoint {
  jobId: string;
  competitorId: string | null;
  runAt: Date;
  avgScore: number;
  avgCoreIntent: number;
  avgEdgeCases: number;
  avgImpliedQuestions: number;
  avgFanOutQueries: number;
  avgRetrievable: number;
  avgExtractable: number;
  avgCitable: number;
  avgReusable: number;
  pagesScored: number;
}

export interface ProjectDetail extends Project {
  competitors: CompetitorConfig[];
  history: ScoreHistoryPoint[];
}

// ── Projects CRUD ─────────────────────────────────────────────

export async function createProject(input: ProjectCreate): Promise<Project> {
  const sql = db();
  const weights = { ...DEFAULT_WEIGHTS, ...input.weights };
  const rows = await sql`
    INSERT INTO projects (client_name, website_url, scope_prefix, max_pages, auth_config, weights)
    VALUES (
      ${input.clientName},
      ${input.websiteUrl},
      ${input.scopePrefix ?? null},
      ${input.maxPages ?? 100},
      ${input.authConfig ? JSON.stringify(input.authConfig) : null},
      ${JSON.stringify(weights)}
    )
    RETURNING *
  `;
  return rowToProject(rows[0]);
}

export async function getProject(id: string): Promise<Project | null> {
  const sql = db();
  const rows = await sql`SELECT * FROM projects WHERE id = ${id}`;
  return rows[0] ? rowToProject(rows[0]) : null;
}

export async function listProjects(): Promise<Project[]> {
  const sql = db();
  const rows = await sql`
    SELECT * FROM projects ORDER BY updated_at DESC
  `;
  return rows.map(rowToProject);
}

export async function updateProject(
  id: string,
  data: Partial<ProjectCreate>
): Promise<Project | null> {
  const sql = db();
  const rows = await sql`
    UPDATE projects SET
      client_name  = COALESCE(${data.clientName ?? null}, client_name),
      website_url  = COALESCE(${data.websiteUrl ?? null}, website_url),
      scope_prefix = COALESCE(${data.scopePrefix ?? null}, scope_prefix),
      max_pages    = COALESCE(${data.maxPages ?? null}, max_pages)
    WHERE id = ${id}
    RETURNING *
  `;
  return rows[0] ? rowToProject(rows[0]) : null;
}

export async function deleteProject(id: string): Promise<void> {
  const sql = db();
  await sql`DELETE FROM projects WHERE id = ${id}`;
}

/** Called after an audit run completes to refresh the cached scores */
export async function refreshProjectCache(projectId: string): Promise<void> {
  const sql = db();

  // Get the two most recent completed runs for the client site
  const runs = await sql`
    SELECT j.id, ROUND(AVG(ps.overall_score)) AS avg_score
    FROM audit_jobs j
    JOIN page_scores ps ON ps.job_id = j.id
    WHERE j.project_id = ${projectId}
      AND j.competitor_id IS NULL
      AND j.status = 'done'
    GROUP BY j.id, j.completed_at
    ORDER BY j.completed_at DESC
    LIMIT 2
  `;

  if (runs.length === 0) return;

  const latest = runs[0].avg_score as number;
  const prev = runs[1]?.avg_score as number | undefined;
  const delta = prev != null ? Math.round((latest - prev) * 10) / 10 : null;
  const grade = scoreToGrade(latest);

  await sql`
    UPDATE projects SET
      latest_score    = ${latest},
      latest_grade    = ${grade},
      score_delta     = ${delta},
      last_audited_at = NOW(),
      run_count       = run_count + 1
    WHERE id = ${projectId}
  `;
}

export async function refreshCompetitorCache(
  competitorId: string
): Promise<void> {
  const sql = db();

  const runs = await sql`
    SELECT j.id, ROUND(AVG(ps.overall_score)) AS avg_score
    FROM audit_jobs j
    JOIN page_scores ps ON ps.job_id = j.id
    WHERE j.competitor_id = ${competitorId} AND j.status = 'done'
    GROUP BY j.id, j.completed_at
    ORDER BY j.completed_at DESC
    LIMIT 2
  `;

  if (runs.length === 0) return;

  const latest = runs[0].avg_score as number;
  const prev = runs[1]?.avg_score as number | undefined;
  const delta = prev != null ? Math.round((latest - prev) * 10) / 10 : null;
  const grade = scoreToGrade(latest);

  await sql`
    UPDATE competitor_configs SET
      latest_score    = ${latest},
      latest_grade    = ${grade},
      score_delta     = ${delta},
      last_audited_at = NOW()
    WHERE id = ${competitorId}
  `;
}

// ── Competitors CRUD ──────────────────────────────────────────

export async function addCompetitor(
  projectId: string,
  data: { name: string; url: string; scopePrefix?: string }
): Promise<CompetitorConfig> {
  const sql = db();

  // Assign next available color index
  const existingRows = await sql`
    SELECT color_index FROM competitor_configs WHERE project_id = ${projectId}
  `;
  const usedIndices = existingRows.map((r) => r.color_index as number);
  const colorIndex = [0, 1, 2, 3, 4].find((i) => !usedIndices.includes(i)) ?? 0;

  const rows = await sql`
    INSERT INTO competitor_configs (project_id, name, url, scope_prefix, color_index)
    VALUES (
      ${projectId},
      ${data.name},
      ${data.url},
      ${data.scopePrefix ?? null},
      ${colorIndex}
    )
    RETURNING *
  `;
  return rowToCompetitor(rows[0]);
}

export async function getCompetitorsByProject(
  projectId: string
): Promise<CompetitorConfig[]> {
  const sql = db();
  const rows = await sql`
    SELECT * FROM competitor_configs WHERE project_id = ${projectId}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToCompetitor);
}

export async function deleteCompetitor(id: string): Promise<void> {
  const sql = db();
  await sql`DELETE FROM competitor_configs WHERE id = ${id}`;
}

// ── Score history ─────────────────────────────────────────────

export async function getProjectHistory(
  projectId: string
): Promise<ScoreHistoryPoint[]> {
  const sql = db();
  const rows = await sql`
    SELECT * FROM project_score_history
    WHERE project_id = ${projectId}
    ORDER BY run_at ASC
  `;
  return rows.map(rowToHistoryPoint);
}

// ── Full project detail ───────────────────────────────────────

export async function getProjectDetail(
  id: string
): Promise<ProjectDetail | null> {
  const project = await getProject(id);
  if (!project) return null;

  const [competitors, history] = await Promise.all([
    getCompetitorsByProject(id),
    getProjectHistory(id),
  ]);

  return { ...project, competitors, history };
}

// ── Row mappers ───────────────────────────────────────────────

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id: r.id as string,
    clientName: r.client_name as string,
    websiteUrl: r.website_url as string,
    scopePrefix: r.scope_prefix as string | null,
    maxPages: r.max_pages as number,
    authConfig: r.auth_config as Record<string, unknown> | null,
    weights: (r.weights as DimensionScores) ?? DEFAULT_WEIGHTS,
    latestScore: r.latest_score as number | null,
    latestGrade: r.latest_grade as string | null,
    scoreDelta: r.score_delta as number | null,
    lastAuditedAt: r.last_audited_at ? new Date(r.last_audited_at as string) : null,
    runCount: r.run_count as number,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

function rowToCompetitor(r: Record<string, unknown>): CompetitorConfig {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    name: r.name as string,
    url: r.url as string,
    scopePrefix: r.scope_prefix as string | null,
    colorIndex: r.color_index as number,
    latestScore: r.latest_score as number | null,
    latestGrade: r.latest_grade as string | null,
    scoreDelta: r.score_delta as number | null,
    lastAuditedAt: r.last_audited_at ? new Date(r.last_audited_at as string) : null,
    createdAt: new Date(r.created_at as string),
  };
}

function rowToHistoryPoint(r: Record<string, unknown>): ScoreHistoryPoint {
  return {
    jobId: r.job_id as string,
    competitorId: r.competitor_id as string | null,
    runAt: new Date(r.run_at as string),
    avgScore: r.avg_score as number,
    avgCoreIntent: r.avg_core_intent as number,
    avgEdgeCases: r.avg_edge_cases as number,
    avgImpliedQuestions: r.avg_implied_questions as number,
    avgFanOutQueries: r.avg_fan_out_queries as number,
    avgRetrievable: r.avg_retrievable as number,
    avgExtractable: r.avg_extractable as number,
    avgCitable: r.avg_citable as number,
    avgReusable: r.avg_reusable as number,
    pagesScored: r.pages_scored as number,
  };
}

function scoreToGrade(score: number): string {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}
