// ─────────────────────────────────────────────────────────────
//  lib/hub.ts — shared server-side helpers for the project
//  section routes (/projects/[id]/*). Extracted from the old
//  single-page hub when it was split into the left-rail app
//  shell (Overview / Pages / AI Visibility / Competitors /
//  Optimize / Reports / Settings), so every section can load
//  exactly the data it needs without copy-pasting queries.
//
//  ⚠️ Every neon() here uses fetchOptions.cache = "no-store" —
//  the Neon serverless driver reads via fetch and Next's Data
//  Cache would otherwise serve stale rows forever (see
//  lib/db/client.ts and the scoring-hang postmortem).
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { getScoresByJob } from "@/lib/db/client";
import { refreshCompetitorCache, refreshProjectCache } from "@/lib/db/projects";
import { enqueueScoreBatch } from "@/lib/queue/qstash";
import { DEFAULT_WEIGHTS, ALL_DIMENSIONS, DIMENSION_LABELS, ALL_BUCKETS, BUCKET_LABELS, isAiFetchLikely } from "@/lib/types";
import { sanitizeBrandProfile, summarizeBrandContext } from "@/lib/brand/types";
import type { DimensionScores, PageScore, ScoreDimension, IntentBucket } from "@/lib/types";
import type { PageOptimizeState } from "@/lib/db/drafts";

export const COMPETITOR_COLORS = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0284c7"];

export function hubSql() {
  return neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
}

export function scoreColor(s: number) {
  if (s >= 80) return "#059669";
  if (s >= 65) return "#2563eb";
  if (s >= 50) return "#d97706";
  if (s >= 35) return "#ea580c";
  return "#dc2626";
}

export function gradeColor(g: string) {
  return g === "A" ? "#059669" : g === "B" ? "#2563eb" : g === "C" ? "#d97706" : g === "D" ? "#ea580c" : "#dc2626";
}

export function medianGrade(scores: PageScore[]): "A" | "B" | "C" | "D" | "F" | null {
  if (!scores.length) return null;
  const rank: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 };
  const letters = ["F", "D", "C", "B", "A"] as const;
  const sorted = scores.map((s) => rank[s.grade] ?? 0).sort((a, b) => a - b);
  return letters[sorted[Math.floor((sorted.length - 1) / 2)]];
}

export function computeQuickSummary(scores: PageScore[]) {
  if (!scores.length) return null as any;
  const dims = ALL_DIMENSIONS;
  const avg = (d: ScoreDimension) => Math.round(scores.reduce((s, p) => s + p.scores[d], 0) / scores.length);
  const avgByDim = Object.fromEntries(dims.map((d) => [d, avg(d)])) as any;
  const avgScore = Math.round(scores.reduce((s, p) => s + p.overallScore, 0) / scores.length);
  const grades: Record<string, number> = { A: 0, B: 0, C: 0, D: 0, F: 0 };
  scores.forEach((s) => (grades[s.grade] = (grades[s.grade] || 0) + 1));
  // All 10 dimensions ranked weakest → strongest (full list, no bottom-4 cut).
  const topIssues = dims
    .map((d) => ({ dimension: d, affectedPages: scores.filter((s) => s.scores[d] < 50).length, averageScore: avgByDim[d] }))
    .sort((a, b) => a.averageScore - b.averageScore);
  const sorted = [...scores].sort((a, b) => b.overallScore - a.overallScore);
  return {
    totalPages: scores.length,
    averageScore: avgScore,
    averageByDimension: avgByDim,
    gradeDistribution: grades,
    topIssues,
    topPages: sorted.slice(0, 5).map((s) => ({ url: s.url, score: s.overallScore })),
    bottomPages: sorted.slice(-5).reverse().map((s) => ({ url: s.url, score: s.overallScore })),
  };
}

// ── Latest completed scores for the client + every competitor ─
export interface LatestScoresBundle {
  latestScoresMap: Record<string, PageScore[]>;
  clientScores: PageScore[];
  clientJobId: string | undefined;
  hasResults: boolean;
}

export async function getLatestScores(projectId: string): Promise<LatestScoresBundle> {
  const sql = hubSql();
  const latestJobs = await sql`
    SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
      id, competitor_id, completed_at, status
    FROM audit_jobs
    WHERE project_id = ${projectId} AND status = 'done'
    ORDER BY COALESCE(competitor_id::text, 'client'), completed_at DESC
  `.catch(() => [] as Record<string, unknown>[]);

  const latestScoresMap: Record<string, PageScore[]> = {};
  for (const job of latestJobs) {
    const key = job.competitor_id ? String(job.competitor_id) : "client";
    latestScoresMap[key] = await getScoresByJob(job.id as string).catch(() => []);
  }
  const clientScores = latestScoresMap["client"] ?? [];
  // The CLIENT's latest done job — latestJobs[0] is not reliable (DISTINCT ON
  // ordering sorts competitor jobs first); classify/backfill posts need the
  // client job id specifically.
  const clientJobId = (latestJobs.find((j) => !j.competitor_id)?.id ?? latestJobs[0]?.id) as string | undefined;
  return { latestScoresMap, clientScores, clientJobId, hasResults: clientScores.length > 0 };
}

// ── Optimized-pages rows (drives OptimizedSummary + badges) ──
export function buildOptimizedRows(
  clientScores: PageScore[],
  optimizeStates: Record<string, PageOptimizeState>
) {
  return clientScores
    .filter((s) => optimizeStates[s.url])
    .map((s) => {
      const st = optimizeStates[s.url];
      return {
        url: s.url,
        pageId: s.pageId,
        baseline: s.overallScore,
        simulated: st.simulatedOverall,
        grade: st.simulatedGrade,
        version: st.version,
        draftCount: st.draftCount,
        draftId: st.draftId,
        simulationId: st.simulationId,
        verified: st.verified,
        verifiedMatched: st.verifiedMatched,
      };
    })
    .sort((a, b) => {
      const da = a.simulated != null ? a.simulated - a.baseline : -Infinity;
      const db = b.simulated != null ? b.simulated - b.baseline : -Infinity;
      return db - da;
    });
}

// ── Crawl-forcing intent-bucket rollup (Optimize cards) ──────
// Counts are real classifier output stored on page_scores; "fetchLikely"
// applies the shared isAiFetchLikely bar (retrievable+citable avg ≥ 60
// within a crawl-forcing bucket). intentBuckets === null means the page
// was scored before the classifier existed and never backfilled.
export interface BucketRollupEntry {
  bucket: IntentBucket;
  label: string;
  count: number;
  fetchLikely: number;
}

export function buildBucketRollup(clientScores: PageScore[]): {
  buckets: BucketRollupEntry[];
  unclassified: number;
  general: number;
} {
  const buckets = ALL_BUCKETS.map((b) => {
    const inBucket = clientScores.filter((s) => (s.intentBuckets ?? []).includes(b));
    return {
      bucket: b,
      label: BUCKET_LABELS[b],
      count: inBucket.length,
      fetchLikely: inBucket.filter((s) => isAiFetchLikely(s.intentBuckets, s.scores)).length,
    };
  });
  const unclassified = clientScores.filter((s) => s.intentBuckets == null).length;
  // General = every page in NO crawl-forcing bucket (classified-matched-none
  // OR not yet classified), so the five cards account for every URL. Buckets
  // are multi-label, so the four intent counts can overlap each other — but
  // General never overlaps them.
  const general = clientScores.filter((s) => (s.intentBuckets ?? []).length === 0).length;
  return { buckets, unclassified, general };
}

// ── Fix-first ranking (guided Overview) ──────────────────────
// Priority = Σ over dimensions of weight_d × max(0, TARGET − score_d).
// Concentrated weaknesses in heavily-weighted dimensions float up — which is
// NOT the same order as "lowest overall first" (uncapped headroom collapses
// to exactly that, since overall is the weighted average). The number is a
// RANKING KEY ONLY: it is never displayed, per the no-modeled-figures rule —
// the UI shows the page's real weakest dimension scores instead.
const FIX_TARGET = 75;

export interface FixFirstEntry {
  url: string;
  pageId: string;
  grade: PageScore["grade"];
  overall: number;
  weakest: { dimension: ScoreDimension; label: string; score: number }[];
  serpFacts: string[];
}

export function buildFixFirst(
  clientScores: PageScore[],
  serpSummaries?: Record<string, { aioTriggered: number; aioCited: number; paaPresent: number; paaOwned: number }>,
  limit = 3
): FixFirstEntry[] {
  const ranked = clientScores
    .map((s) => {
      const priority = ALL_DIMENSIONS.reduce(
        (sum, d) => sum + DEFAULT_WEIGHTS[d] * Math.max(0, FIX_TARGET - s.scores[d]),
        0
      );
      return { s, priority };
    })
    .filter((r) => r.priority > 0)
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);

  return ranked.map(({ s }) => {
    const weakest = ALL_DIMENSIONS.map((d) => ({ dimension: d, label: DIMENSION_LABELS[d], score: s.scores[d] }))
      .sort((a, b) => a.score - b.score)
      .slice(0, 2);
    const serpFacts: string[] = [];
    const sum = serpSummaries?.[s.url];
    if (sum) {
      if (sum.aioTriggered > 0 && sum.aioCited === 0)
        serpFacts.push(`AI Overviews trigger on ${sum.aioTriggered} of its keywords without citing this page`);
      if (sum.paaPresent > 0 && sum.paaOwned === 0)
        serpFacts.push(`${sum.paaPresent} PAA question${sum.paaPresent === 1 ? "" : "s"} on its SERPs, none answered by you`);
    }
    return { url: s.url, pageId: s.pageId, grade: s.grade, overall: s.overallScore, weakest, serpFacts };
  });
}

// ── Self-heal + expiry sweep (was inline in the hub page) ────
// Reconciles jobs stuck in 'scoring'/'crawling' against ACTUAL page_scores
// rows: (a) fully scored but never flipped to done → finalize; (b) crawl-claim
// race left pages un-dispatched → re-dispatch just those. Also fails out jobs
// older than 2 hours. Cheap: only touches this project's not-yet-final jobs.
export async function runSelfHeal(projectId: string): Promise<void> {
  const sql = hubSql();
  const stuckJobs = await sql`
    SELECT id, competitor_id, weights, updated_at
    FROM audit_jobs
    WHERE project_id = ${projectId} AND status IN ('scoring', 'crawling')
  `.catch(() => [] as Record<string, unknown>[]);
  for (const j of stuckJobs) {
    const jobId = j.id as string;
    const pageRows = await sql`SELECT id FROM audit_pages WHERE job_id = ${jobId}`.catch(() => [] as Record<string, unknown>[]);
    if (pageRows.length === 0) continue; // nothing crawled yet — leave it alone
    const scoredRows = await sql`SELECT page_id FROM page_scores WHERE job_id = ${jobId}`.catch(() => [] as Record<string, unknown>[]);
    const scoredSet = new Set(scoredRows.map((r) => String(r.page_id)));
    const unscored = pageRows.map((p) => String(p.id)).filter((id) => !scoredSet.has(id));

    if (unscored.length === 0) {
      await sql`
        UPDATE audit_jobs SET status = 'done', completed_at = NOW()
        WHERE id = ${jobId} AND status IN ('scoring', 'crawling')
      `.catch(() => null);
      if (j.competitor_id) {
        await refreshCompetitorCache(String(j.competitor_id)).catch(() => null);
      } else {
        await refreshProjectCache(projectId).catch(() => null);
      }
    } else {
      // Guard on updated_at so we don't re-enqueue on every render while a
      // batch is still in flight.
      const updatedAt = j.updated_at ? new Date(j.updated_at as string).getTime() : 0;
      if (Date.now() - updatedAt > 90_000) {
        const weights = { ...DEFAULT_WEIGHTS, ...((j.weights as object) ?? {}) } as DimensionScores;
        for (let i = 0; i < unscored.length; i += 10) {
          await enqueueScoreBatch({ jobId, pageIds: unscored.slice(i, i + 10), weights }).catch(() => null);
        }
        await sql`UPDATE audit_jobs SET updated_at = NOW() WHERE id = ${jobId}`.catch(() => null);
      }
    }
  }

  // Auto-expire jobs older than 2 hours that are still stuck.
  await sql`
    UPDATE audit_jobs
    SET status = 'failed', error_message = 'Timed out — job exceeded 2 hour limit'
    WHERE project_id = ${projectId}
      AND status NOT IN ('done', 'failed')
      AND created_at <= NOW() - INTERVAL '2 hours'
  `.catch(() => null);
}

export async function getActiveJobs(projectId: string) {
  const sql = hubSql();
  // Only jobs created in the last 2 hours, so a stale stuck job never shows.
  return sql`
    SELECT id, competitor_id, status, crawled_pages, total_pages, scored_pages
    FROM audit_jobs
    WHERE project_id = ${projectId}
      AND status NOT IN ('done', 'failed')
      AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC LIMIT 5
  `.catch(() => [] as Record<string, unknown>[]);
}

// ── Stale-baseline check (pre-determinism score rows) ────────
export async function isStaleBaseline(clientJobId: string | undefined): Promise<boolean> {
  if (!clientJobId) return false;
  const sql = hubSql();
  const staleRows = await sql`
    SELECT COUNT(*)::int AS n FROM page_scores
    WHERE job_id = ${clientJobId}
      AND content_hash IS NULL
      AND model_version <> 'error'
  `.catch(() => [] as Record<string, unknown>[]);
  return ((staleRows[0]?.n as number) ?? 0) > 0;
}

// ── Rail badge stats (project layout) ────────────────────────
export interface RailStats {
  clientName: string;
  websiteUrl: string;
  pageCount: number;
  needsWork: number;
  competitorCount: number;
  /** TRUE when a brand profile exists with ≥1 enabled, non-empty section. */
  brandActive: boolean;
  exists: boolean;
}

export async function getRailStats(projectId: string): Promise<RailStats> {
  const sql = hubSql();
  const projRows = await sql`
    SELECT client_name, website_url FROM projects WHERE id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  if (projRows.length === 0) {
    return { clientName: "", websiteUrl: "", pageCount: 0, needsWork: 0, competitorCount: 0, brandActive: false, exists: false };
  }
  const jobRows = await sql`
    SELECT id FROM audit_jobs
    WHERE project_id = ${projectId} AND competitor_id IS NULL AND status = 'done'
    ORDER BY completed_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  let pageCount = 0;
  let needsWork = 0;
  if (jobRows[0]?.id) {
    const c = await sql`
      SELECT COUNT(*)::int AS n,
             COUNT(*) FILTER (WHERE grade IN ('D','F'))::int AS w
      FROM page_scores
      WHERE job_id = ${jobRows[0].id as string} AND model_version <> 'error'
    `.catch(() => [] as Record<string, unknown>[]);
    pageCount = (c[0]?.n as number) ?? 0;
    needsWork = (c[0]?.w as number) ?? 0;
  }
  const compRows = await sql`
    SELECT COUNT(*)::int AS n FROM competitor_configs WHERE project_id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  // brand_profiles is lazily created by lib/brand/store — before its first
  // DDL run the query fails, which the catch reads as "no profile yet".
  const brandRows = await sql`
    SELECT profile FROM brand_profiles WHERE project_id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  const brandActive = brandRows[0]
    ? summarizeBrandContext(sanitizeBrandProfile(brandRows[0].profile)).active
    : false;
  return {
    clientName: String(projRows[0].client_name ?? ""),
    websiteUrl: String(projRows[0].website_url ?? ""),
    pageCount,
    needsWork,
    competitorCount: (compRows[0]?.n as number) ?? 0,
    brandActive,
    exists: true,
  };
}
