import { neon } from "@neondatabase/serverless";
import type {
  AuditJob,
  AuditJobCreate,
  CrawledPage,
  PageScore,
  DimensionScores,
  Recommendation,
} from "@/lib/types";
import { DEFAULT_WEIGHTS as DW } from "@/lib/types";

// ─────────────────────────────────────────────────────────────
//  Neon serverless SQL client
// ─────────────────────────────────────────────────────────────

function getDb() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not set");
  }
  // `cache: "no-store"` is REQUIRED: the Neon serverless driver issues its
  // queries via `fetch`, and Next.js's App Router silently caches those fetch
  // responses in its Data Cache. Without this, reads (e.g. GET /api/audit/[id]
  // that the live banner polls) keep returning a stale snapshot from early in
  // the run forever — so a finished job still shows "crawling 1/25" and the
  // banner spins indefinitely. Segment-level `force-dynamic` does NOT reliably
  // reach the driver's fetch; this driver-level option is the guaranteed fix.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

// ── Lazy schema patches ───────────────────────────────────────
// Idempotent DDL applied on demand (there is no migration runner in this
// deploy pipeline). Memoized per lambda instance so the hot scoring path pays
// the roundtrip once per cold start; every statement is a no-op after the
// first ever run.
let schemaPatched: Promise<void> | null = null;

export function ensureSchemaPatches(): Promise<void> {
  if (!schemaPatched) {
    schemaPatched = (async () => {
      const sql = getDb();
      await sql`
        ALTER TABLE page_scores
        ADD COLUMN IF NOT EXISTS evidence JSONB NOT NULL DEFAULT '{}'
      `;
      // Intent-bucket classification (crawl-forcing query categories).
      // intent_buckets: NULL = never classified (backfill candidate);
      //                 '[]' = classified, matched no bucket (evergreen).
      await sql`
        ALTER TABLE page_scores
        ADD COLUMN IF NOT EXISTS intent_buckets JSONB
      `;
      await sql`
        ALTER TABLE page_scores
        ADD COLUMN IF NOT EXISTS primary_bucket TEXT
      `;
      await sql`
        ALTER TABLE page_scores
        ADD COLUMN IF NOT EXISTS bucket_evidence JSONB NOT NULL DEFAULT '{}'
      `;
      // content_hash: sha256 of the exact scoring input. Identical hash on a
      // later run ⇒ the stored score is copied verbatim instead of re-calling
      // the model — the determinism/repeatability guarantee.
      await sql`
        ALTER TABLE page_scores
        ADD COLUMN IF NOT EXISTS content_hash TEXT
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_page_scores_content_hash
        ON page_scores(content_hash)
      `;
      // Recreate the trend view so failed-scoring placeholder rows
      // (model_version='error') can no longer drag historical averages —
      // a transient blip must not move a chart.
      await sql`
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
          AND ps.model_version <> 'error'
        GROUP BY j.project_id, j.competitor_id, j.id, j.completed_at
        ORDER BY j.completed_at ASC
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS gap_briefs (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id        UUID NOT NULL,
          competitor_id     UUID NOT NULL,
          dimension         TEXT NOT NULL,
          client_job_id     UUID NOT NULL,
          competitor_job_id UUID NOT NULL,
          brief             TEXT NOT NULL,
          model_version     TEXT NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (project_id, competitor_id, dimension, client_job_id, competitor_job_id)
        )
      `;
    })().catch((err) => {
      // Allow a retry on the next call instead of caching the failure forever.
      schemaPatched = null;
      throw err;
    });
  }
  return schemaPatched;
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

export interface StoredPage {
  id: string;
  url: string;
  title: string;
  metaDescription: string;
  bodyText: string;
  wordCount: number;
  headings: { level: number; text: string }[];
  internalLinks: string[];
  externalLinks: string[];
  metadata: Record<string, unknown>;
  httpStatus: number;
}

export async function getPagesByJob(jobId: string): Promise<StoredPage[]> {
  const sql = getDb();
  // Full column set: scoring previously read only body_text + metadata, so the
  // model was scoring every page with an empty title, "(no headings found)",
  // Word Count 0 and 0 links — blinding the Retrievable/Fan-out dimensions to
  // data the crawler had already stored.
  // ORDER BY url: deterministic batch composition run-to-run.
  const rows = await sql`
    SELECT id, url, title, meta_description, body_text, word_count,
           headings, internal_links, external_links, metadata, http_status
    FROM audit_pages WHERE job_id = ${jobId}
    ORDER BY url ASC
  `;
  return rows.map((r) => ({
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
  }));
}

// ── Scores ────────────────────────────────────────────────────

export async function upsertScore(score: PageScore): Promise<void> {
  const sql = getDb();
  // The evidence column may not exist on databases created before the
  // evidence-capture feature — patch before the first write needs it.
  await ensureSchemaPatches();
  // NOTE: page_scores has no UNIQUE constraint on page_id in the live DB, so we
  // cannot use `INSERT ... ON CONFLICT (page_id)` (Postgres throws 42P10 — "no
  // unique or exclusion constraint matching the ON CONFLICT specification",
  // which previously stalled every audit at the scoring step). Delete-then-
  // insert is idempotent per page and safe here because each page is scored by
  // exactly one score_batch, so there is no concurrent writer for a given page.
  await sql`DELETE FROM page_scores WHERE page_id = ${score.pageId}`;
  await sql`
    INSERT INTO page_scores (
      page_id, job_id,
      score_core_intent, score_edge_cases, score_implied_questions,
      score_fan_out_queries, score_retrievable, score_extractable,
      score_citable, score_reusable,
      rationale, evidence, overall_score, grade, recommendations, model_version,
      intent_buckets, primary_bucket, bucket_evidence,
      content_hash
    ) VALUES (
      ${score.pageId}, ${score.jobId},
      ${score.scores.coreIntent}, ${score.scores.edgeCases},
      ${score.scores.impliedQuestions}, ${score.scores.fanOutQueries},
      ${score.scores.retrievable}, ${score.scores.extractable},
      ${score.scores.citable}, ${score.scores.reusable},
      ${JSON.stringify(score.rationale)},
      ${JSON.stringify(score.evidence ?? {})},
      ${score.overallScore}, ${score.grade},
      ${JSON.stringify(score.recommendations)},
      ${score.modelVersion},
      ${score.intentBuckets != null ? JSON.stringify(score.intentBuckets) : null},
      ${score.primaryBucket ?? null},
      ${JSON.stringify(score.bucketEvidence ?? {})},
      ${score.contentHash ?? null}
    )
  `;
}

export async function getScoresByJob(jobId: string): Promise<PageScore[]> {
  const sql = getDb();
  // model_version <> 'error': failed-scoring placeholders are bookkeeping rows
  // (they make the completion count add up) — never real scores. Excluding
  // them here keeps every consumer (summaries, cards, matrix, gap briefs)
  // clean without each one re-implementing the filter.
  // url ASC tiebreak: equal scores must order identically on every read.
  const rows = await sql`
    SELECT ps.*, ap.url
    FROM page_scores ps
    JOIN audit_pages ap ON ap.id = ps.page_id
    WHERE ps.job_id = ${jobId}
      AND ps.model_version <> 'error'
    ORDER BY ps.overall_score DESC, ap.url ASC
  `;
  return rows.map(rowToScore);
}

/**
 * Determinism guarantee: find the most recent successful score for the same
 * URL whose content hash matches the exact scoring input we are about to send.
 * A hit means nothing relevant changed (content, metadata, prompt version,
 * model, weights) — so the stored score, rationale, evidence, and
 * recommendations are reused byte-for-byte instead of re-rolling the model.
 */
export async function findReusableScore(
  url: string,
  contentHash: string
): Promise<PageScore | null> {
  const sql = getDb();
  await ensureSchemaPatches();
  const rows = await sql`
    SELECT ps.*, ap.url
    FROM page_scores ps
    JOIN audit_pages ap ON ap.id = ps.page_id
    WHERE ap.url = ${url}
      AND ps.content_hash = ${contentHash}
      AND ps.model_version <> 'error'
    ORDER BY ps.scored_at DESC
    LIMIT 1
  `;
  return rows[0] ? rowToScore(rows[0]) : null;
}

/**
 * Count the score rows actually persisted for a job. This is the source of
 * truth for "is this job fully scored?" — unlike the audit_jobs.scored_pages
 * counter, which is a running tally that can under-count under concurrent
 * writes and strand a fully-scored job in `scoring` forever (observed live:
 * 10 scores written but scored_pages read 0).
 */
// ── Intent-bucket classification (backfill path) ──────────────

/**
 * Write classification onto an existing score row without touching the scores
 * themselves. Used by the classify_batch backfill for pre-feature rows.
 */
export async function updatePageClassification(
  pageId: string,
  classification: {
    intentBuckets: string[];
    primaryBucket: string | null;
    bucketEvidence: Record<string, string>;
  }
): Promise<void> {
  const sql = getDb();
  await ensureSchemaPatches();
  await sql`
    UPDATE page_scores SET
      intent_buckets  = ${JSON.stringify(classification.intentBuckets)},
      primary_bucket  = ${classification.primaryBucket},
      bucket_evidence = ${JSON.stringify(classification.bucketEvidence)}
    WHERE page_id = ${pageId}
  `;
}

/**
 * Score rows for a job that have never been classified (intent_buckets IS
 * NULL), joined to their page content for the classify-only LLM call.
 */
export async function getUnclassifiedPagesForJob(
  jobId: string
): Promise<{ id: string; url: string; title: string; bodyText: string }[]> {
  const sql = getDb();
  await ensureSchemaPatches();
  const rows = await sql`
    SELECT ap.id, ap.url, ap.title, ap.body_text
    FROM page_scores ps
    JOIN audit_pages ap ON ap.id = ps.page_id
    WHERE ps.job_id = ${jobId} AND ps.intent_buckets IS NULL
  `;
  return rows.map((r) => ({
    id: r.id as string,
    url: r.url as string,
    title: (r.title as string) ?? "",
    bodyText: (r.body_text as string) ?? "",
  }));
}

/** {total, classified} score-row counts for a job — drives backfill progress. */
export async function getClassificationStatus(
  jobId: string
): Promise<{ total: number; classified: number }> {
  const sql = getDb();
  await ensureSchemaPatches();
  const rows = await sql`
    SELECT
      COUNT(*)::int AS total,
      COUNT(intent_buckets)::int AS classified
    FROM page_scores
    WHERE job_id = ${jobId}
  `;
  return {
    total: (rows[0]?.total as number) ?? 0,
    classified: (rows[0]?.classified as number) ?? 0,
  };
}

export async function countScoresByJob(jobId: string): Promise<number> {
  const sql = getDb();
  const rows = await sql`SELECT COUNT(*)::int AS n FROM page_scores WHERE job_id = ${jobId}`;
  return (rows[0]?.n as number) ?? 0;
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
    evidence: (r.evidence as PageScore["evidence"]) ?? {},
    intentBuckets: (r.intent_buckets as PageScore["intentBuckets"]) ?? null,
    primaryBucket: (r.primary_bucket as PageScore["primaryBucket"]) ?? null,
    bucketEvidence: (r.bucket_evidence as PageScore["bucketEvidence"]) ?? {},
    overallScore: r.overall_score as number,
    grade: r.grade as PageScore["grade"],
    recommendations: r.recommendations as Recommendation[],
    modelVersion: r.model_version as string,
    contentHash: (r.content_hash as string | null) ?? null,
    scoredAt: new Date(r.scored_at as string),
  };
}
