// ─────────────────────────────────────────────────────────────
//  Optimize workbench persistence: page drafts + sandboxed
//  simulation results.
//
//  Deliberately separate from lib/db/client.ts and from the
//  page_scores table: simulations are WHAT-IF scores and must never
//  leak into real audit history, averages, trend charts, or
//  competitor comparisons. Nothing in the audit pipeline reads
//  these tables.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import type {
  DimensionScores,
  DimensionRationale,
  DimensionEvidence,
  Recommendation,
  PageMetadata,
} from "@/lib/types";
import type { StoredPage } from "@/lib/db/client";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  // no-store: required — the Neon driver reads via fetch and Next's Data Cache
  // would otherwise serve stale drafts/simulations forever (see lib/db/client.ts).
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

// ── Lazy schema (same idempotent-DDL pattern as ensureSchemaPatches,
//    but scoped here so the audit hot path never pays for it) ──
let optimizeSchemaReady: Promise<void> | null = null;

export function ensureOptimizeSchema(): Promise<void> {
  if (!optimizeSchemaReady) {
    optimizeSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS page_drafts (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id       UUID NOT NULL,
          page_id          UUID NOT NULL,
          job_id           UUID NOT NULL,
          url              TEXT NOT NULL,
          version          INTEGER NOT NULL,
          title            TEXT NOT NULL DEFAULT '',
          meta_description TEXT NOT NULL DEFAULT '',
          body_md          TEXT NOT NULL DEFAULT '',
          metadata         JSONB NOT NULL DEFAULT '{}',
          internal_links   JSONB NOT NULL DEFAULT '[]',
          external_links   JSONB NOT NULL DEFAULT '[]',
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (page_id, version)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_page_drafts_page ON page_drafts(page_id)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS draft_simulations (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          draft_id        UUID NOT NULL,
          page_id         UUID NOT NULL,
          project_id      UUID NOT NULL,
          url             TEXT NOT NULL,
          scores          JSONB NOT NULL,
          rationale       JSONB NOT NULL DEFAULT '{}',
          evidence        JSONB NOT NULL DEFAULT '{}',
          recommendations JSONB NOT NULL DEFAULT '[]',
          overall_score   SMALLINT NOT NULL,
          grade           CHAR(1) NOT NULL,
          model_version   TEXT NOT NULL,
          prompt_version  TEXT NOT NULL,
          content_hash    TEXT NOT NULL,
          weights         JSONB NOT NULL DEFAULT '{}',
          reused          BOOLEAN NOT NULL DEFAULT FALSE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_draft_sims_draft ON draft_simulations(draft_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_draft_sims_project_time
        ON draft_simulations(project_id, created_at)
      `;
      // Phase 2: cached live-web research suggestions per (page, dimension).
      // Cache serves repeat opens for free; a new row is only written by a
      // fresh (paid) web-search call, so the row count doubles as the
      // cost-control counter.
      await sql`
        CREATE TABLE IF NOT EXISTS research_results (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          page_id       UUID NOT NULL,
          project_id    UUID NOT NULL,
          dimension     TEXT NOT NULL,
          suggestions   JSONB NOT NULL DEFAULT '[]',
          model_version TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_research_page_dim
        ON research_results(page_id, dimension, created_at)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_research_project_time
        ON research_results(project_id, created_at)
      `;
      // Phase 3: post-publish verification results. Sandboxed like
      // simulations — the audit pipeline never reads this table; real audit
      // history only changes through a normal audit run.
      await sql`
        CREATE TABLE IF NOT EXISTS draft_verifications (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          page_id           UUID NOT NULL,
          draft_id          UUID NOT NULL,
          simulation_id     UUID NOT NULL,
          project_id        UUID NOT NULL,
          matched           BOOLEAN NOT NULL,
          live_content_hash TEXT NOT NULL,
          real_scores       JSONB NOT NULL DEFAULT '{}',
          real_overall      SMALLINT NOT NULL,
          real_grade        CHAR(1) NOT NULL,
          fidelity          JSONB NOT NULL DEFAULT '{}',
          model_version     TEXT NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_verifications_draft
        ON draft_verifications(draft_id, created_at)
      `;
    })().catch((err) => {
      optimizeSchemaReady = null; // allow retry instead of caching the failure
      throw err;
    });
  }
  return optimizeSchemaReady;
}

// ── Types ─────────────────────────────────────────────────────

export interface PageDraft {
  id: string;
  projectId: string;
  pageId: string;
  jobId: string;
  url: string;
  version: number;
  title: string;
  metaDescription: string;
  bodyMd: string;
  metadata: PageMetadata;
  internalLinks: string[];
  externalLinks: string[];
  createdAt: Date;
}

export interface DraftSimulation {
  id: string;
  draftId: string;
  pageId: string;
  projectId: string;
  url: string;
  scores: DimensionScores;
  rationale: DimensionRationale;
  evidence: DimensionEvidence;
  recommendations: Recommendation[];
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  modelVersion: string;
  promptVersion: string;
  contentHash: string;
  weights: DimensionScores;
  reused: boolean;
  createdAt: Date;
}

export interface DraftInput {
  projectId: string;
  pageId: string;
  jobId: string;
  url: string;
  title: string;
  metaDescription: string;
  bodyMd: string;
  metadata: PageMetadata;
  internalLinks: string[];
  externalLinks: string[];
}

// ── Drafts ────────────────────────────────────────────────────

export async function createDraft(input: DraftInput): Promise<PageDraft> {
  await ensureOptimizeSchema();
  const sql = db();
  // Next version number for this page. The UNIQUE(page_id, version) constraint
  // makes a concurrent double-save fail loudly instead of silently forking the
  // version history; the client just retries.
  const rows = await sql`
    INSERT INTO page_drafts (
      project_id, page_id, job_id, url, version,
      title, meta_description, body_md, metadata, internal_links, external_links
    )
    VALUES (
      ${input.projectId}, ${input.pageId}, ${input.jobId}, ${input.url},
      COALESCE((SELECT MAX(version) FROM page_drafts WHERE page_id = ${input.pageId}), 0) + 1,
      ${input.title}, ${input.metaDescription}, ${input.bodyMd},
      ${JSON.stringify(input.metadata)},
      ${JSON.stringify(input.internalLinks)},
      ${JSON.stringify(input.externalLinks)}
    )
    RETURNING *
  `;
  return rowToDraft(rows[0]);
}

export async function getDraft(id: string): Promise<PageDraft | null> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`SELECT * FROM page_drafts WHERE id = ${id}`;
  return rows[0] ? rowToDraft(rows[0]) : null;
}

export async function getDraftsByPage(pageId: string): Promise<PageDraft[]> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM page_drafts WHERE page_id = ${pageId} ORDER BY version DESC
  `;
  return rows.map(rowToDraft);
}

// ── Simulations ───────────────────────────────────────────────

export async function insertSimulation(
  sim: Omit<DraftSimulation, "id" | "createdAt">
): Promise<DraftSimulation> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    INSERT INTO draft_simulations (
      draft_id, page_id, project_id, url,
      scores, rationale, evidence, recommendations,
      overall_score, grade, model_version, prompt_version,
      content_hash, weights, reused
    ) VALUES (
      ${sim.draftId}, ${sim.pageId}, ${sim.projectId}, ${sim.url},
      ${JSON.stringify(sim.scores)}, ${JSON.stringify(sim.rationale)},
      ${JSON.stringify(sim.evidence)}, ${JSON.stringify(sim.recommendations)},
      ${sim.overallScore}, ${sim.grade}, ${sim.modelVersion}, ${sim.promptVersion},
      ${sim.contentHash}, ${JSON.stringify(sim.weights)}, ${sim.reused}
    )
    RETURNING *
  `;
  return rowToSim(rows[0]);
}

export async function getSimulation(id: string): Promise<DraftSimulation | null> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`SELECT * FROM draft_simulations WHERE id = ${id}`;
  return rows[0] ? rowToSim(rows[0]) : null;
}

/** Latest simulation per draft for a page (drives the version dropdown labels). */
export async function getSimulationsByPage(pageId: string): Promise<DraftSimulation[]> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    SELECT DISTINCT ON (draft_id) *
    FROM draft_simulations
    WHERE page_id = ${pageId}
    ORDER BY draft_id, created_at DESC
  `;
  return rows.map(rowToSim);
}

/**
 * Simulations run for a project in the last 24h — the cost-control counter
 * behind OPTIMIZE_SIM_DAILY_CAP (every non-reused simulation is a paid model
 * call, and the workbench is client-facing).
 */
export async function countRecentSimulations(projectId: string): Promise<number> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM draft_simulations
    WHERE project_id = ${projectId}
      AND reused = FALSE
      AND created_at > NOW() - INTERVAL '24 hours'
  `;
  return (rows[0]?.n as number) ?? 0;
}

// ── Research suggestions (Phase 2) ────────────────────────────

export interface ResearchSuggestion {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
}

export interface ResearchResult {
  id: string;
  pageId: string;
  projectId: string;
  dimension: string;
  suggestions: ResearchSuggestion[];
  modelVersion: string;
  createdAt: Date;
}

export async function insertResearch(
  r: Omit<ResearchResult, "id" | "createdAt">
): Promise<ResearchResult> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    INSERT INTO research_results (page_id, project_id, dimension, suggestions, model_version)
    VALUES (
      ${r.pageId}, ${r.projectId}, ${r.dimension},
      ${JSON.stringify(r.suggestions)}, ${r.modelVersion}
    )
    RETURNING *
  `;
  return rowToResearch(rows[0]);
}

export async function getLatestResearch(
  pageId: string,
  dimension: string
): Promise<ResearchResult | null> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM research_results
    WHERE page_id = ${pageId} AND dimension = ${dimension}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  return rows[0] ? rowToResearch(rows[0]) : null;
}

/** Fresh (paid) research calls for a project in the last 24h — drives OPTIMIZE_RESEARCH_DAILY_CAP. */
export async function countRecentResearch(projectId: string): Promise<number> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    SELECT COUNT(*)::int AS n
    FROM research_results
    WHERE project_id = ${projectId}
      AND created_at > NOW() - INTERVAL '24 hours'
  `;
  return (rows[0]?.n as number) ?? 0;
}

function rowToResearch(r: Record<string, unknown>): ResearchResult {
  return {
    id: r.id as string,
    pageId: r.page_id as string,
    projectId: r.project_id as string,
    dimension: r.dimension as string,
    suggestions: (r.suggestions as ResearchSuggestion[]) ?? [],
    modelVersion: r.model_version as string,
    createdAt: new Date(r.created_at as string),
  };
}

// ── Verifications (Phase 3) ───────────────────────────────────

export interface VerificationFidelity {
  /** 0–100 word-overlap similarity between published bodyText and the draft's. */
  matchPct: number;
  titleMatch: boolean;
  metaMatch: boolean;
  /** Heading texts in the draft but missing from the published page (≤5). */
  missingHeadings: string[];
  /** Heading texts on the published page but not in the draft (≤5). */
  extraHeadings: string[];
  /** Sentences on the published page that aren't in the draft (≤3, truncated). */
  publishedNotInDraft: string[];
  /** Sentences in the draft that didn't make it to the published page (≤3). */
  draftNotInPublished: string[];
}

export interface DraftVerification {
  id: string;
  pageId: string;
  draftId: string;
  simulationId: string;
  projectId: string;
  matched: boolean;
  liveContentHash: string;
  realScores: DimensionScores;
  realOverall: number;
  realGrade: "A" | "B" | "C" | "D" | "F";
  fidelity: VerificationFidelity | Record<string, never>;
  modelVersion: string;
  createdAt: Date;
}

export async function insertVerification(
  v: Omit<DraftVerification, "id" | "createdAt">
): Promise<DraftVerification> {
  await ensureOptimizeSchema();
  const sql = db();
  const rows = await sql`
    INSERT INTO draft_verifications (
      page_id, draft_id, simulation_id, project_id,
      matched, live_content_hash, real_scores, real_overall, real_grade,
      fidelity, model_version
    ) VALUES (
      ${v.pageId}, ${v.draftId}, ${v.simulationId}, ${v.projectId},
      ${v.matched}, ${v.liveContentHash}, ${JSON.stringify(v.realScores)},
      ${v.realOverall}, ${v.realGrade}, ${JSON.stringify(v.fidelity)}, ${v.modelVersion}
    )
    RETURNING *
  `;
  return rowToVerification(rows[0]);
}

function rowToVerification(r: Record<string, unknown>): DraftVerification {
  return {
    id: r.id as string,
    pageId: r.page_id as string,
    draftId: r.draft_id as string,
    simulationId: r.simulation_id as string,
    projectId: r.project_id as string,
    matched: r.matched as boolean,
    liveContentHash: r.live_content_hash as string,
    realScores: r.real_scores as DimensionScores,
    realOverall: r.real_overall as number,
    realGrade: r.real_grade as DraftVerification["realGrade"],
    fidelity: (r.fidelity as VerificationFidelity) ?? {},
    modelVersion: r.model_version as string,
    createdAt: new Date(r.created_at as string),
  };
}

// ── Page lookup (by id, with its job's weights) ───────────────

export interface OptimizePageBundle {
  page: StoredPage;
  jobId: string;
  projectId: string | null;
  weights: Record<string, number>;
}

/**
 * The audit_pages row + the weights of the job that crawled it. Simulations
 * must score with the SAME weights as the baseline run or the overall-score
 * delta would mix a content change with a weighting change.
 */
export async function getPageForOptimize(
  pageId: string
): Promise<OptimizePageBundle | null> {
  const sql = db();
  const rows = await sql`
    SELECT ap.id, ap.job_id, ap.url, ap.title, ap.meta_description, ap.body_text,
           ap.word_count, ap.headings, ap.internal_links, ap.external_links,
           ap.metadata, ap.http_status,
           j.weights AS job_weights, j.project_id
    FROM audit_pages ap
    JOIN audit_jobs j ON j.id = ap.job_id
    WHERE ap.id = ${pageId}
  `;
  const r = rows[0];
  if (!r) return null;
  return {
    page: {
      id: r.id as string,
      url: r.url as string,
      title: (r.title as string) ?? "",
      metaDescription: (r.meta_description as string) ?? "",
      bodyText: (r.body_text as string) ?? "",
      wordCount: (r.word_count as number) ?? 0,
      headings: (r.headings as { level: number; text: string }[]) ?? [],
      internalLinks: (r.internal_links as string[]) ?? [],
      externalLinks: (r.external_links as string[]) ?? [],
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      httpStatus: (r.http_status as number) ?? 200,
    },
    jobId: r.job_id as string,
    projectId: (r.project_id as string | null) ?? null,
    weights: (r.job_weights as Record<string, number>) ?? {},
  };
}

// ── Row mappers ───────────────────────────────────────────────

function rowToDraft(r: Record<string, unknown>): PageDraft {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    pageId: r.page_id as string,
    jobId: r.job_id as string,
    url: r.url as string,
    version: r.version as number,
    title: (r.title as string) ?? "",
    metaDescription: (r.meta_description as string) ?? "",
    bodyMd: (r.body_md as string) ?? "",
    metadata: (r.metadata as PageMetadata) ?? { hasStructuredData: false },
    internalLinks: (r.internal_links as string[]) ?? [],
    externalLinks: (r.external_links as string[]) ?? [],
    createdAt: new Date(r.created_at as string),
  };
}

function rowToSim(r: Record<string, unknown>): DraftSimulation {
  return {
    id: r.id as string,
    draftId: r.draft_id as string,
    pageId: r.page_id as string,
    projectId: r.project_id as string,
    url: r.url as string,
    scores: r.scores as DimensionScores,
    rationale: (r.rationale as DimensionRationale) ?? ({} as DimensionRationale),
    evidence: (r.evidence as DimensionEvidence) ?? {},
    recommendations: (r.recommendations as Recommendation[]) ?? [],
    overallScore: r.overall_score as number,
    grade: r.grade as DraftSimulation["grade"],
    modelVersion: r.model_version as string,
    promptVersion: r.prompt_version as string,
    contentHash: r.content_hash as string,
    weights: r.weights as DimensionScores,
    reused: (r.reused as boolean) ?? false,
    createdAt: new Date(r.created_at as string),
  };
}
