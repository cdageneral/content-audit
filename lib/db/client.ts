import { neon } from "@neondatabase/serverless";
import type {
  AuditJob,
  AuditJobCreate,
  CrawledPage,
  PageScore,
  DimensionScores,
  Recommendation,
  DEFAULT_WEIGHTS,
} from "@/lib/types";
import { DEFAULT_WEIGHTS as DW } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
//  Neon serverless SQL client
// ─────────────────────────────────────────────────────────────

function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  return neon(process.env.DATABASE_URL);
}

// ── Jobs ──────────────────────────────────────────────────────

export async function createJob(input: AuditJobCreate): Promise<AuditJob> {
  const sql = getDb();
  const weights = { ...DW, ...input.weights };

  const rows = await sql`
    INSERT INTO audit_jobs (url, scope_prefix, max_pages, weights)
    VALUES (
      ${input.url},
      ${input.scopePrefix ?? null},
      ${input.maxPages ?? 500},
      ${JSON.stringify(weights)}
    )
    RETURNING *
  `;
  return rowToJob(rows[0]);
}

export async function getJob(id: string): Promise<AuditJob | null> {
  const sql = getDb();
  const rows = await sql`SELECT * FROM audit_jobs WHERE id = ${id}`;
  return rows[0] ? rowToJob(rows[0]) : null;
}

export async function listJobs(limit = 20): Promise<AuditJob[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT * FROM audit_jobs ORDER BY created_at DESC LIMIT ${limit}
  `;
  return rows.map(rowToJob);
}

export async function updateJobStatus(
  id: string,
  status: AuditJob["status"],
  extras: Partial<{
    totalPages: number;
    crawledPages: number;
    scoredPages: number;
    errorMessage: string;
  }> = {}
): Promise<void> {
  const sql = getDb();
  const completedAt = status === "done" || status === "failed" ? new Date() : null;

  await sql`
    UPDATE audit_jobs SET
      status        = ${status},
      total_pages   = COALESCE(${extras.totalPages ?? null}, total_pages),
      crawled_pages = COALESCE(${extras.crawledPages ?? null}, crawled_pages),
      scored_pages  = COALESCE(${extras.scoredPages ?? null}, scored_pages),
      error_message = COALESCE(${extras.errorMessage ?? null}, error_message),
      completed_at  = COALESCE(${completedAt?.toISOString() ?? null}::timestamptz, completed_at)
    WHERE id = ${id}
  `;
}

export async function incrementJobProgress(
  id: string,
  field: "crawled_pages" | "scored_pages",
  by = 1
): Promise<void> {
  const sql = getDb();
  if (field === "crawled_pages") {
    await sql`UPDATE audit_jobs SET crawled_pages = crawled_pages + ${by} WHERE id = ${id}`;
  } else {
    await sql`UPDATE audit_jobs SET scored_pages = scored_pages + ${by} WHERE id = ${id}`;
  }
}

// ── Pages ─────────────────────────────────────────────────────

export async function upsertPage(page: CrawledPage): Promise<string> {
  const sql = getDb();
  const rows = await sql`
    INSERT INTO audit_pages (
      job_id, url, title, meta_description,
      body_text, word_count, headings,
      internal_links, external_links, metadata, http_status
    ) VALUES (
      ${page.jobId}, ${page.url}, ${page.title}, ${page.metaDescription},
      ${page.bodyText.slice(0, 65535)},
      ${page.wordCount},
      ${JSON.stringify(page.headings)},
      ${JSON.stringify(page.internalLinks)},
      ${JSON.stringify(page.externalLinks)},
      ${JSON.stringify(page.metadata)},
      ${page.httpStatus}
    )
    ON CONFLICT (job_id, url) DO UPDATE SET
      title             = EXCLUDED.title,
      meta_description  = EXCLUDED.meta_description,
      body_text         = EXCLUDED.body_text,
      word_count        = EXCLUDED.word_count,
      headings          = EXCLUDED.headings,
      internal_links    = EXCLUDED.internal_links,
      external_links    = EXCLUDED.external_links,
      metadata          = EXCLUDED.metadata,
      http_status       = EXCLUDED.http_status
    RETURNING id
  `;
  return rows[0].id as string;
}

export async function getPagesByJob(jobId: string): Promise<{ id: string; url: string; bodyText: string; metadata: Record<string, unknown> }[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT id, url, body_text, metadata FROM audit_pages WHERE job_id = ${jobId}
  `;
  return rows.map((r) => ({
    id: r.id as string,
    url: r.url as string,
    bodyText: r.body_text as string,
    metadata: r.metadata as Record<string, unknown>,
  }));
}

// ── Scores ────────────────────────────────────────────────────

export async function upsertScore(score: PageScore): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO page_scores (
      page_id, job_id,
      score_core_intent, score_edge_cases, score_implied_questions,
      score_fan_out_queries, score_retrievable, score_extractable,
      score_citable, score_reusable,
      rationale, overall_score, grade, recommendations, model_version
    ) VALUES (
      ${score.pageId}, ${score.jobId},
      ${score.scores.coreIntent}, ${score.scores.edgeCases},
      ${score.scores.impliedQuestions}, ${score.scores.fanOutQueries},
      ${score.scores.retrievable}, ${score.scores.extractable},
      ${score.scores.citable}, ${score.scores.reusable},
      ${JSON.stringify(score.rationale)},
      ${score.overallScore}, ${score.grade},
      ${JSON.stringify(score.recommendations)},
      ${score.modelVersion}
    )
    ON CONFLICT (page_id) DO UPDATE SET
      score_core_intent       = EXCLUDED.score_core_intent,
      score_edge_cases        = EXCLUDED.score_edge_cases,
      score_implied_questions = EXCLUDED.score_implied_questions,
      score_fan_out_queries   = EXCLUDED.score_fan_out_queries,
      score_retrievable       = EXCLUDED.score_retrievable,
      score_extractable       = EXCLUDED.score_extractable,
      score_citable           = EXCLUDED.score_citable,
      score_reusable          = EXCLUDED.score_reusable,
      rationale               = EXCLUDED.rationale,
      overall_score           = EXCLUDED.overall_score,
      grade                   = EXCLUDED.grade,
      recommendations         = EXCLUDED.recommendations,
      model_version           = EXCLUDED.model_version,
      scored_at               = NOW()
  `;
}

export async function getScoresByJob(jobId: string): Promise<PageScore[]> {
  const sql = getDb();
  const rows = await sql`
    SELECT ps.*, ap.url
    FROM page_scores ps
    JOIN audit_pages ap ON ap.id = ps.page_id
    WHERE ps.job_id = ${jobId}
    ORDER BY ps.overall_score DESC
  `;
  return rows.map(rowToScore);
}

// ── Row mappers ───────────────────────────────────────────────

function rowToJob(r: Record<string, unknown>): AuditJob {
  return {
    id: r.id as string,
    url: r.url as string,
    scopePrefix: r.scope_prefix as string | null,
    auth: null, // never returned from DB directly; use auth_configs table
    maxPages: r.max_pages as number,
    weights: (r.weights as DimensionScores) ?? DW,
    status: r.status as AuditJob["status"],
    totalPages: r.total_pages as number,
    crawledPages: r.crawled_pages as number,
    scoredPages: r.scored_pages as number,
    errorMessage: r.error_message as string | null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
    completedAt: r.completed_at ? new Date(r.completed_at as string) : null,
  };
}

function rowToScore(r: Record<string, unknown>): PageScore {
  const scores: DimensionScores = {
    coreIntent: r.score_core_intent as number,
    edgeCases: r.score_edge_cases as number,
    impliedQuestions: r.score_implied_questions as number,
    fanOutQueries: r.score_fan_out_queries as number,
    retrievable: r.score_retrievable as number,
    extractable: r.score_extractable as number,
    citable: r.score_citable as number,
    reusable: r.score_reusable as number,
  };
  return {
    id: r.id as string,
    pageId: r.page_id as string,
    jobId: r.job_id as string,
    url: r.url as string,
    scores,
    rationale: r.rationale as PageScore["rationale"],
    overallScore: r.overall_score as number,
    grade: r.grade as PageScore["grade"],
    recommendations: r.recommendations as Recommendation[],
    modelVersion: r.model_version as string,
    scoredAt: new Date(r.scored_at as string),
  };
}
