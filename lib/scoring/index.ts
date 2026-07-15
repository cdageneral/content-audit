// ─────────────────────────────────────────────────────────────
//  Scoring Engine — calls Claude with tool_use, returns PageScore
// ─────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import type {
  CrawledPage,
  PageScore,
  DimensionScores,
  DimensionRationale,
  DimensionEvidence,
  Recommendation,
  ScoreDimension,
} from "@/lib/types";
import { DEFAULT_WEIGHTS as DW } from "@/lib/types";
import { SCORING_SYSTEM_PROMPT, SCORE_TOOL_DEFINITION } from "./prompt";

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

const SCORING_MODEL = process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

// ── Score a single page ───────────────────────────────────────

export async function scorePage(
  page: CrawledPage,
  pageId: string,
  weights: DimensionScores = DW
): Promise<PageScore> {
  const userMessage = buildScoringMessage(page);

  const response = await client.messages.create({
    model: SCORING_MODEL,
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
  return buildPageScore(raw, page, pageId, weights, SCORING_MODEL);
}

// ── Score a batch of pages (rate-limit aware) ─────────────────

export async function scoreBatch(
  pages: CrawledPage[],
  pageIds: string[],
  weights: DimensionScores = DW,
  onProgress?: (pageId: string) => void
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

    try {
      // Race each page against a hard timeout so one slow/hung call can never
      // freeze the batch (the original bug: no timeout → permanent stall).
      const score = await withTimeout(
        scorePage(pages[i], pageIds[i], weights),
        PAGE_SCORE_TIMEOUT_MS,
        pages[i].url
      );
      results.push(score);
    } catch (err) {
      console.error(`[scoring] Error scoring ${pages[i].url}:`, err);
      // Push a zero-score placeholder so we don't block the whole batch
      results.push(zeroScore(pages[i], pageIds[i]));
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
  modelVersion: string
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

  return {
    id: crypto.randomUUID(),
    pageId,
    jobId: page.jobId,
    url: page.url,
    scores,
    rationale,
    evidence,
    overallScore,
    grade,
    recommendations,
    modelVersion,
    scoredAt: new Date(),
  };
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
    overallScore: 0,
    grade: "F",
    recommendations: [],
    modelVersion: "error",
    scoredAt: new Date(),
  };
}

// ── Audit summary computation ─────────────────────────────────

export function computeAuditSummary(scores: PageScore[]) {
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

  const sorted = [...scores].sort((a, b) => b.overallScore - a.overallScore);
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
