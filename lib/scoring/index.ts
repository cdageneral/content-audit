// ─────────────────────────────────────────────────────────────
//  Scoring Engine — calls Claude with tool_use, returns PageScore
// ─────────────────────────────────────────────────────────────

import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import type {
  CrawledPage,
  PageScore,
  DimensionScores,
  DimensionRationale,
  DimensionEvidence,
  Recommendation,
  ScoreDimension,
  IntentBucket,
  BucketEvidence,
} from "@/lib/types";
import { DEFAULT_WEIGHTS as DW, ALL_BUCKETS } from "@/lib/types";
import {
  SCORING_SYSTEM_PROMPT,
  SCORE_TOOL_DEFINITION,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_TOOL_DEFINITION,
  PROMPT_VERSION,
} from "./prompt";

// Bounded client: a per-request network timeout + capped retries so a single
// slow/hung Anthropic call can never block a whole scoring batch indefinitely.
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 30_000,
  maxRetries: 2,
});

// Hard per-page ceiling (belt to the SDK timeout's suspenders): if one page
// somehow exceeds this, we abandon it, record a zero-score, and move on.
const PAGE_SCORE_TIMEOUT_MS = 45_000;

// Whole-batch deadline: guarantee the function returns before Vercel's 300s
// maxDuration kills it mid-batch (which would drop every in-memory score).
const BATCH_DEADLINE_MS = 250_000;

// Keep this pinned to a DATED snapshot (never a floating alias like
// "claude-haiku-4-5") — a silent model upgrade would shift every score with no
// content change. The model id is part of the content hash below, so an
// intentional model change correctly invalidates cached scores.
export const SCORING_MODEL = process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

// ── Content hash: the repeatability contract ──────────────────
// sha256 over the EXACT model input: the fully built scoring message (page
// content, metadata, headings, link counts) + system-prompt version + model id
// + the weights used for the overall score. If none of those changed since a
// prior run, the stored score is reused verbatim — no model call, no drift.
export function computeContentHash(
  page: CrawledPage,
  weights: DimensionScores
): string {
  const basis = JSON.stringify({
    promptVersion: PROMPT_VERSION,
    model: SCORING_MODEL,
    weights,
    message: buildScoringMessage(page),
  });
  return createHash("sha256").update(basis).digest("hex");
}

// ── Score a single page ───────────────────────────────────────

export async function scorePage(
  page: CrawledPage,
  pageId: string,
  weights: DimensionScores = DW,
  contentHash?: string
): Promise<PageScore> {
  const userMessage = buildScoringMessage(page);

  const response = await client.messages.create({
    model: SCORING_MODEL,
    // temperature 0: greedy decoding. The API default is 1.0 (full creative
    // sampling), which re-rolls the scores on every run — unacceptable for an
    // audit that must be repeatable. 0 minimizes run-to-run variance; the
    // content-hash reuse path above it is what makes unchanged content
    // EXACTLY repeatable.
    temperature: 0,
    // 4096: the evidence quotes added to the tool schema can consume ~600
    // extra output tokens; at 2048 a verbose page could truncate the tool
    // input mid-JSON, dropping `recommendations` (emitted last) and NULL-
    // violating page_scores on the webhook hot path.
    max_tokens: 4096,
    system: SCORING_SYSTEM_PROMPT,
    tools: [SCORE_TOOL_DEFINITION],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: userMessage }],
  });

  // Extract tool_use result
  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Scoring failed for ${page.url}: no tool_use in response`);
  }

  const raw = toolUse.input as Record<string, unknown>;
  return buildPageScore(raw, page, pageId, weights, SCORING_MODEL, contentHash);
}

// ── Score a batch of pages (rate-limit aware) ─────────────────

export async function scoreBatch(
  pages: CrawledPage[],
  pageIds: string[],
  weights: DimensionScores = DW,
  onProgress?: (pageId: string) => void,
  contentHashes?: (string | undefined)[]
): Promise<PageScore[]> {
  const results: PageScore[] = [];

  const batchStart = Date.now();

  for (let i = 0; i < pages.length; i++) {
    // Whole-batch deadline guard: if we're near Vercel's function limit, stop
    // calling Claude and zero-fill the rest so the scores we DID compute still
    // get written and the job can complete instead of being killed mid-batch.
    if (Date.now() - batchStart > BATCH_DEADLINE_MS) {
      console.warn(
        `[scoring] Batch deadline hit after ${i}/${pages.length} pages — zero-filling remainder.`
      );
      for (let j = i; j < pages.length; j++) {
        results.push(zeroScore(pages[j], pageIds[j]));
        onProgress?.(pageIds[j]);
      }
      break;
    }

    // Race each page against a hard timeout so one slow/hung call can never
    // freeze the batch (the original bug: no timeout → permanent stall).
    const attempt = () =>
      withTimeout(
        scorePage(pages[i], pageIds[i], weights, contentHashes?.[i]),
        PAGE_SCORE_TIMEOUT_MS,
        pages[i].url
      );

    try {
      results.push(await attempt());
    } catch (err) {
      // One retry before giving up: a transient timeout/blip must not become a
      // recorded score. (Skip the retry if the batch deadline is close.)
      console.error(`[scoring] Error scoring ${pages[i].url} (will retry once):`, err);
      if (Date.now() - batchStart < BATCH_DEADLINE_MS - PAGE_SCORE_TIMEOUT_MS) {
        try {
          await sleep(1_000);
          results.push(await attempt());
        } catch (err2) {
          console.error(`[scoring] Retry also failed for ${pages[i].url}:`, err2);
          // Failed-marker row (model_version='error'): counts toward job
          // completion but is EXCLUDED from every average and display — a
          // network blip must never enter a client-facing score.
          results.push(zeroScore(pages[i], pageIds[i]));
        }
      } else {
        results.push(zeroScore(pages[i], pageIds[i]));
      }
    } finally {
      // Always advance the counter — failed pages must not stall the pipeline
      onProgress?.(pageIds[i]);
    }

    // Brief pause between API calls (Haiku has generous rate limits)
    if (i < pages.length - 1) {
      await sleep(300);
    }
  }

  return results;
}

// ── Message builder ───────────────────────────────────────────

function buildScoringMessage(page: CrawledPage): string {
  const headingOutline = page.headings
    .map((h) => `${"  ".repeat(h.level - 1)}- [H${h.level}] ${h.text}`)
    .join("\n");

  const metaParts = [
    page.metadata.author && `Author: ${page.metadata.author}`,
    page.metadata.publishedDate && `Published: ${page.metadata.publishedDate}`,
    page.metadata.modifiedDate && `Modified: ${page.metadata.modifiedDate}`,
    page.metadata.canonicalUrl && `Canonical: ${page.metadata.canonicalUrl}`,
    page.metadata.schemaOrgType && `Schema.org type: ${page.metadata.schemaOrgType}`,
    `Has structured data: ${page.metadata.hasStructuredData}`,
  ]
    .filter(Boolean)
    .join("\n");

  // Truncate body text to stay within token budget
  const bodyExcerpt = page.bodyText.slice(0, 12_000);
  const truncated = page.bodyText.length > 12_000;

  return `Please score the following web page for LLM readiness.

## Page Details
URL: ${page.url}
Title: ${page.title}
Meta Description: ${page.metaDescription || "(none)"}
Word Count: ${page.wordCount}
HTTP Status: ${page.httpStatus}
Internal Links: ${page.internalLinks.length}
External Links: ${page.externalLinks.length}

## Metadata
${metaParts || "(none detected)"}

## Heading Structure
${headingOutline || "(no headings found)"}

## Page Content
${bodyExcerpt}${truncated ? "\n\n[Content truncated at 12,000 characters]" : ""}

---
Please analyze this content and call the record_content_scores tool with your assessment.`;
}

// ── Score builder ─────────────────────────────────────────────

function buildPageScore(
  raw: Record<string, unknown>,
  page: CrawledPage,
  pageId: string,
  weights: DimensionScores,
  modelVersion: string,
  contentHash?: string
): PageScore {
  const scores: DimensionScores = {
    coreIntent: clamp(raw.coreIntent as number),
    edgeCases: clamp(raw.edgeCases as number),
    impliedQuestions: clamp(raw.impliedQuestions as number),
    fanOutQueries: clamp(raw.fanOutQueries as number),
    retrievable: clamp(raw.retrievable as number),
    extractable: clamp(raw.extractable as number),
    citable: clamp(raw.citable as number),
    reusable: clamp(raw.reusable as number),
  };

  // Defensive defaults: a truncated tool_use response (max_tokens hit) can
  // legally omit any late-emitted property. Missing rationale/recommendations
  // must degrade to empty values, never to `undefined` — JSON.stringify(
  // undefined) is undefined, which would NULL-violate page_scores' NOT NULL
  // columns and strand the job in 'scoring' via endless QStash retries.
  const rationale = (
    raw.rationale && typeof raw.rationale === "object" ? raw.rationale : {}
  ) as DimensionRationale;
  // Evidence is best-effort: older prompts (and occasional model omissions)
  // won't include it, so default to an empty object and sanitize shape.
  const evidence = sanitizeEvidence(raw.evidence);
  const recommendations = (
    Array.isArray(raw.recommendations) ? raw.recommendations : []
  ) as Recommendation[];
  const overallScore = computeWeightedScore(scores, weights);
  const grade = scoreToGrade(overallScore);
  const classification = sanitizeClassification(raw);

  return {
    id: crypto.randomUUID(),
    pageId,
    jobId: page.jobId,
    url: page.url,
    scores,
    rationale,
    evidence,
    intentBuckets: classification.intentBuckets,
    primaryBucket: classification.primaryBucket,
    bucketEvidence: classification.bucketEvidence,
    overallScore,
    grade,
    recommendations,
    modelVersion,
    contentHash: contentHash ?? null,
    scoredAt: new Date(),
  };
}

// ── Intent-bucket classification ─────────────────────────────

export interface PageClassification {
  intentBuckets: IntentBucket[];
  primaryBucket: IntentBucket | null;
  bucketEvidence: BucketEvidence;
}

/**
 * Validate the model's bucket output. Unknown bucket names are dropped; the
 * primary is coerced into the assigned set (falling back to the first bucket)
 * so the UI can always trust `primaryBucket ∈ intentBuckets || null`.
 */
function sanitizeClassification(raw: Record<string, unknown>): PageClassification {
  const isBucket = (v: unknown): v is IntentBucket =>
    typeof v === "string" && (ALL_BUCKETS as string[]).includes(v);

  const intentBuckets = (Array.isArray(raw.intentBuckets)
    ? raw.intentBuckets.filter(isBucket)
    : []) as IntentBucket[];
  // De-dupe while preserving order (no Set spread — tsconfig targets es5)
  const unique = intentBuckets.filter((b, i) => intentBuckets.indexOf(b) === i);

  let primaryBucket: IntentBucket | null = null;
  if (unique.length > 0) {
    primaryBucket = isBucket(raw.primaryBucket) && unique.includes(raw.primaryBucket)
      ? raw.primaryBucket
      : unique[0];
  }

  const bucketEvidence: BucketEvidence = {};
  if (raw.bucketEvidence && typeof raw.bucketEvidence === "object") {
    for (const [k, v] of Object.entries(raw.bucketEvidence as Record<string, unknown>)) {
      if (isBucket(k) && unique.includes(k) && typeof v === "string" && v.trim()) {
        bucketEvidence[k] = v.slice(0, 200);
      }
    }
  }

  return { intentBuckets: unique, primaryBucket, bucketEvidence };
}

/**
 * Classification-only call for the backfill path: buckets an already-scored
 * page without re-running the full 8-dimension score (cheaper + leaves the
 * existing scores untouched).
 */
export async function classifyPage(page: {
  url: string;
  title?: string;
  bodyText: string;
}): Promise<PageClassification> {
  const bodyExcerpt = page.bodyText.slice(0, 12_000);
  const userMessage = `Classify the following web page into intent buckets.

URL: ${page.url}
${page.title ? `Title: ${page.title}` : ""}

## Page Content
${bodyExcerpt}${page.bodyText.length > 12_000 ? "\n\n[Content truncated at 12,000 characters]" : ""}

---
Call the record_intent_buckets tool with your classification.`;

  const response = await client.messages.create({
    model: SCORING_MODEL,
    max_tokens: 1024,
    system: CLASSIFY_SYSTEM_PROMPT,
    tools: [CLASSIFY_TOOL_DEFINITION],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content: userMessage }],
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error(`Classification failed for ${page.url}: no tool_use in response`);
  }
  return sanitizeClassification(toolUse.input as Record<string, unknown>);
}

// Per-page ceiling for a classification call (smaller than scoring — the
// output is tiny) and the same batch deadline guard as scoring.
const PAGE_CLASSIFY_TIMEOUT_MS = 30_000;

/**
 * Classify a batch of pages. Failed pages resolve to `null` (left unclassified
 * so a later backfill run can retry them) rather than a fake empty result.
 */
export async function classifyBatch(
  pages: { id: string; url: string; title?: string; bodyText: string }[]
): Promise<Map<string, PageClassification>> {
  const results = new Map<string, PageClassification>();
  const batchStart = Date.now();

  for (let i = 0; i < pages.length; i++) {
    if (Date.now() - batchStart > BATCH_DEADLINE_MS) {
      console.warn(
        `[classify] Batch deadline hit after ${i}/${pages.length} pages — leaving remainder unclassified.`
      );
      break;
    }
    try {
      const c = await withTimeout(
        classifyPage(pages[i]),
        PAGE_CLASSIFY_TIMEOUT_MS,
        pages[i].url
      );
      results.set(pages[i].id, c);
    } catch (err) {
      console.error(`[classify] Error classifying ${pages[i].url}:`, err);
      // Skip — page stays unclassified (intent_buckets NULL) and is retryable.
    }
    if (i < pages.length - 1) await sleep(300);
  }

  return results;
}

/** Keep only string-array values, cap 2 quotes per dimension, 200 chars each. */
function sanitizeEvidence(raw: unknown): DimensionEvidence {
  if (!raw || typeof raw !== "object") return {};
  const out: DimensionEvidence = {};
  for (const [dim, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(val)) continue;
    const quotes = val
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, 2)
      .map((q) => q.slice(0, 200));
    if (quotes.length) out[dim as ScoreDimension] = quotes;
  }
  return out;
}

// ── Weighted score ────────────────────────────────────────────

export function computeWeightedScore(
  scores: DimensionScores,
  weights: DimensionScores
): number {
  const totalWeight = Object.values(weights).reduce((a, b) => a + b, 0);
  const weightedSum = (Object.keys(scores) as ScoreDimension[]).reduce(
    (sum, dim) => sum + scores[dim] * (weights[dim] ?? 0),
    0
  );
  return Math.round(weightedSum / totalWeight);
}

// ── Utilities ─────────────────────────────────────────────────

// Plain code-unit comparison (NOT localeCompare, which can differ across ICU
// builds/locales) — deterministic everywhere.
function byUrl(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function scoreToGrade(score: number): PageScore["grade"] {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function clamp(val: number): number {
  return Math.min(100, Math.max(0, Math.round(val ?? 0)));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Reject if `promise` doesn't settle within `ms`. Used to bound each Claude
// scoring call so one hung request can't stall an entire batch.
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Scoring timed out after ${ms}ms: ${label}`)),
      ms
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function zeroScore(page: CrawledPage, pageId: string): PageScore {
  const zeroScores: DimensionScores = {
    coreIntent: 0,
    edgeCases: 0,
    impliedQuestions: 0,
    fanOutQueries: 0,
    retrievable: 0,
    extractable: 0,
    citable: 0,
    reusable: 0,
  };
  const zeroRationale: DimensionRationale = {
    coreIntent: "Scoring failed",
    edgeCases: "Scoring failed",
    impliedQuestions: "Scoring failed",
    fanOutQueries: "Scoring failed",
    retrievable: "Scoring failed",
    extractable: "Scoring failed",
    citable: "Scoring failed",
    reusable: "Scoring failed",
  };
  return {
    id: crypto.randomUUID(),
    pageId,
    jobId: page.jobId,
    url: page.url,
    scores: zeroScores,
    rationale: zeroRationale,
    evidence: {},
    // null (not []) — the page was never actually classified, so the backfill
    // path can pick it up later instead of treating it as "matched no buckets".
    intentBuckets: null,
    primaryBucket: null,
    bucketEvidence: {},
    overallScore: 0,
    grade: "F",
    recommendations: [],
    // 'error' marks this as a FAILED-SCORING placeholder, not a real F. Every
    // average, ranking, cache refresh, and the history view filters these out
    // (model_version <> 'error') — the row exists only so the job-completion
    // row count still adds up. It carries no content hash, so the page is
    // scored fresh on the next run instead of the failure being reused.
    modelVersion: "error",
    contentHash: null,
    scoredAt: new Date(),
  };
}

// ── Audit summary computation ─────────────────────────────────

export function computeAuditSummary(allScores: PageScore[]) {
  // Failed-scoring placeholders (model_version='error') are not real scores —
  // averaging their zeros would let a transient network blip move a site's
  // grade between runs with no content change.
  const scores = allScores.filter((s) => s.modelVersion !== "error");
  if (scores.length === 0) {
    return null;
  }

  const dims: ScoreDimension[] = [
    "coreIntent",
    "edgeCases",
    "impliedQuestions",
    "fanOutQueries",
    "retrievable",
    "extractable",
    "citable",
    "reusable",
  ];

  const averageByDimension = {} as DimensionScores;
  for (const dim of dims) {
    const avg =
      scores.reduce((s, p) => s + p.scores[dim], 0) / scores.length;
    averageByDimension[dim] = Math.round(avg);
  }

  const averageScore = Math.round(
    scores.reduce((s, p) => s + p.overallScore, 0) / scores.length
  );

  const gradeDistribution: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  for (const s of scores) gradeDistribution[s.grade]++;

  const topIssues = dims
    .map((dim) => ({
      dimension: dim,
      affectedPages: scores.filter((s) => s.scores[dim] < 50).length,
      averageScore: averageByDimension[dim],
    }))
    .sort((a, b) => a.averageScore - b.averageScore)
    .slice(0, 4);

  // URL tiebreak: two pages with equal scores must rank identically on every
  // run — score-only sorting lets ties swap places between renders.
  const sorted = [...scores].sort(
    (a, b) => b.overallScore - a.overallScore || byUrl(a.url, b.url)
  );
  const topPages = sorted.slice(0, 5).map((s) => ({ url: s.url, score: s.overallScore }));
  const bottomPages = sorted
    .slice(-5)
    .reverse()
    .map((s) => ({ url: s.url, score: s.overallScore }));

  return {
    totalPages: scores.length,
    averageScore,
    averageByDimension,
    gradeDistribution,
    topIssues,
    topPages,
    bottomPages,
  };
}
