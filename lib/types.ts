// ─────────────────────────────────────────────────────────────
//  Core domain types for the AI Content Audit Agent
// ─────────────────────────────────────────────────────────────

// ── Auth Config ──────────────────────────────────────────────

export type AuthType = "none" | "cookie" | "bearer" | "basic";

export interface AuthConfig {
  type: AuthType;
  /** Cookie string (e.g. "session=abc; csrf=xyz") */
  cookie?: string;
  /** Bearer token */
  token?: string;
  /** Basic auth credentials */
  username?: string;
  password?: string;
}

// ── Audit Job ────────────────────────────────────────────────

export type JobStatus =
  | "queued"
  | "discovering"
  | "crawling"
  | "scoring"
  | "done"
  | "failed";

export interface AuditJobCreate {
  url: string;
  /** Optional directory prefix to restrict crawl scope, e.g. "/docs" */
  scopePrefix?: string;
  auth?: AuthConfig;
  /** Maximum pages to crawl (safety cap). Default: 500 */
  maxPages?: number;
  /** Scoring dimension weights (0–1, must sum to 1 if all provided) */
  weights?: ScoreWeights;
}

export interface AuditJob {
  id: string;
  url: string;
  scopePrefix: string | null;
  auth: AuthConfig | null;
  maxPages: number;
  weights: ScoreWeights;
  status: JobStatus;
  totalPages: number;
  crawledPages: number;
  scoredPages: number;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

// ── Progress event (streamed via SSE) ────────────────────────

export interface ProgressEvent {
  jobId: string;
  status: JobStatus;
  totalPages: number;
  crawledPages: number;
  scoredPages: number;
  currentUrl?: string;
  errorMessage?: string;
}

// ── Crawled page ─────────────────────────────────────────────

export interface CrawledPage {
  jobId: string;
  url: string;
  title: string;
  metaDescription: string;
  /** Clean extracted body text */
  bodyText: string;
  wordCount: number;
  /** Heading outline [{ level: 1|2|3, text }] */
  headings: { level: number; text: string }[];
  /** Internal links found on this page */
  internalLinks: string[];
  /** External links found on this page */
  externalLinks: string[];
  /** author, date, canonical, schema.org type, etc. */
  metadata: PageMetadata;
  httpStatus: number;
  crawledAt: Date;
}

export interface PageMetadata {
  author?: string;
  publishedDate?: string;
  modifiedDate?: string;
  canonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  schemaOrgType?: string;
  hasStructuredData: boolean;
  language?: string;
}

// ── Scores ───────────────────────────────────────────────────

/**
 * The 8 scoring dimensions:
 *  Content quality: coreIntent, edgeCases, impliedQuestions, fanOutQueries
 *  LLM Ables:       retrievable, extractable, citable, reusable
 */
export type ScoreDimension =
  | "coreIntent"
  | "edgeCases"
  | "impliedQuestions"
  | "fanOutQueries"
  | "retrievable"
  | "extractable"
  | "citable"
  | "reusable";

export const ALL_DIMENSIONS: ScoreDimension[] = [
  "coreIntent",
  "edgeCases",
  "impliedQuestions",
  "fanOutQueries",
  "retrievable",
  "extractable",
  "citable",
  "reusable",
];

export const DIMENSION_LABELS: Record<ScoreDimension, string> = {
  coreIntent: "Core Intent",
  edgeCases: "Edge Cases",
  impliedQuestions: "Implied Questions",
  fanOutQueries: "Fan-out Queries",
  retrievable: "Retrievable",
  extractable: "Extractable",
  citable: "Citable",
  reusable: "Reusable",
};

export const DIMENSION_GROUPS = {
  contentQuality: ["coreIntent", "edgeCases", "impliedQuestions", "fanOutQueries"] as ScoreDimension[],
  theAblesGroup: ["retrievable", "extractable", "citable", "reusable"] as ScoreDimension[],
};

export type DimensionScores = Record<ScoreDimension, number>;
export type DimensionRationale = Record<ScoreDimension, string>;
/**
 * Optional per-dimension verbatim evidence quotes (1–2 short excerpts from the
 * page that most influenced the score). Only present on scores produced after
 * the evidence-capture prompt shipped — older rows have an empty object.
 */
export type DimensionEvidence = Partial<Record<ScoreDimension, string[]>>;

export interface ScoreWeights extends Partial<DimensionScores> {}

// ── Intent buckets (crawl-forcing query categories) ──────────
//
// Categorizes a page by the kind of user query its content answers. All four
// bucket types force an AI answer engine (ChatGPT search, Perplexity, Google
// AI Overviews) to fetch live web content rather than answer from training
// data — which makes pages in these buckets candidates for being retrieved
// and cited in AI answers.

export type IntentBucket = "recency" | "ranking" | "local" | "comparison";

export const ALL_BUCKETS: IntentBucket[] = [
  "recency",
  "ranking",
  "local",
  "comparison",
];

export const BUCKET_LABELS: Record<IntentBucket, string> = {
  recency: "Recency",
  ranking: "Ranking",
  local: "Local",
  comparison: "Comparison",
};

export const BUCKET_DESCRIPTIONS: Record<IntentBucket, string> = {
  recency: "Point-in-time content — rates, prices, \"best of {year}\", news. Forces a live crawl.",
  ranking: "Best-of / top-N positioning content that answers rank-style queries.",
  local: "Location-based intent — \"near me\", city or region-specific services.",
  comparison: "Head-to-head product or service comparisons (X vs Y).",
};

/** Per-bucket short evidence quote explaining why the page fits that bucket. */
export type BucketEvidence = Partial<Record<IntentBucket, string>>;

/**
 * Minimum retrievable/citable average for a bucketed page to count as
 * "likely to be fetched in an AI answer": the intent type forces a crawl,
 * and the page's own retrieval readiness clears the bar.
 */
export const AI_FETCH_READINESS_BAR = 60;

/**
 * True when a page both matches a crawl-forcing intent bucket AND is
 * retrieval-ready enough to plausibly be selected for the answer.
 */
export function isAiFetchLikely(
  intentBuckets: IntentBucket[] | null | undefined,
  scores: DimensionScores
): boolean {
  if (!intentBuckets || intentBuckets.length === 0) return false;
  const readiness = (scores.retrievable + scores.citable) / 2;
  return readiness >= AI_FETCH_READINESS_BAR;
}

export const DEFAULT_WEIGHTS: DimensionScores = {
  coreIntent: 0.15,
  edgeCases: 0.10,
  impliedQuestions: 0.15,
  fanOutQueries: 0.10,
  retrievable: 0.15,
  extractable: 0.15,
  citable: 0.10,
  reusable: 0.10,
};

export interface PageScore {
  id: string;
  pageId: string;
  jobId: string;
  url: string;
  scores: DimensionScores;
  rationale: DimensionRationale;
  /** Verbatim quotes backing each dimension score (absent/empty for pre-evidence runs) */
  evidence?: DimensionEvidence;
  /**
   * Crawl-forcing intent buckets this page's content fits (multi-label).
   * `null` = page has never been classified (pre-feature rows awaiting
   * backfill); `[]` = classified and matched none (evergreen/other).
   */
  intentBuckets?: IntentBucket[] | null;
  /** Dominant bucket when multiple apply; null when unclassified or none fit. */
  primaryBucket?: IntentBucket | null;
  /** Short per-bucket evidence for why the content fits each assigned bucket. */
  bucketEvidence?: BucketEvidence;
  /** Weighted overall score 0–100 */
  overallScore: number;
  /** Human-readable tier: A/B/C/D/F */
  grade: "A" | "B" | "C" | "D" | "F";
  /** Top 3 improvement recommendations */
  recommendations: Recommendation[];
  modelVersion: string;
  /**
   * sha256 of the exact scoring input (page content + metadata + prompt
   * version + model + weights). Identical hash ⇒ the stored score is reused
   * verbatim instead of re-calling the model — the repeatability guarantee.
   * Null on rows scored before this shipped.
   */
  contentHash?: string | null;
  scoredAt: Date;
}

export interface Recommendation {
  dimension: ScoreDimension;
  priority: "critical" | "high" | "medium" | "low";
  suggestion: string;
  /** Concrete example of the improvement */
  example?: string;
}

// ── API response shapes ───────────────────────────────────────

export interface CreateAuditResponse {
  jobId: string;
  status: JobStatus;
  estimatedPages?: number;
}

export interface AuditResultsResponse {
  job: AuditJob;
  pages: PageScore[];
  summary: AuditSummary;
}

export interface AuditSummary {
  totalPages: number;
  averageScore: number;
  averageByDimension: DimensionScores;
  gradeDistribution: Record<string, number>;
  topIssues: { dimension: ScoreDimension; affectedPages: number; averageScore: number }[];
  topPages: { url: string; score: number }[];
  bottomPages: { url: string; score: number }[];
}

// ── Queue message shapes ──────────────────────────────────────

export interface CrawlBatchMessage {
  jobId: string;
  urls: string[];
  auth: AuthConfig | null;
  batchIndex: number;
  totalBatches: number;
}

export interface ScoreBatchMessage {
  jobId: string;
  pageIds: string[];
  weights: DimensionScores;
}

/** Classification-only backfill batch: bucket already-scored pages without re-scoring. */
export interface ClassifyBatchMessage {
  jobId: string;
  pageIds: string[];
}
