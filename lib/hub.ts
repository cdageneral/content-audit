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

// ── Last-run failure (surfaced as an alert on the Overview) ──
//
//  Without this the app fails silently: the client job is marked `failed`,
//  getActiveJobs excludes failed rows so no banner shows, and the page
//  re-renders byte-identical — which is exactly what "the Run button
//  flashes and nothing happens" looked like. It also restores the blocked-
//  site alert that was lost when this page was rebuilt for the left rail.

/** Written by start.ts when a newer run supersedes an older one — not a real failure. */
const SUPERSEDED = "Superseded by new run";

export interface LastRunFailure {
  jobId: string;
  message: string;
  at: string | null;
}

export async function getLastRunFailure(projectId: string): Promise<LastRunFailure | null> {
  const sql = hubSql();
  const rows = await sql`
    SELECT id, status, error_message, completed_at, created_at
    FROM audit_jobs
    WHERE project_id = ${projectId} AND competitor_id IS NULL
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);

  const row = rows[0];
  if (!row || row.status !== "failed") return null;

  const message = (row.error_message as string | null) ?? "";
  // A superseded job is bookkeeping, not something to alarm the user about.
  if (!message || message === SUPERSEDED) return null;

  return {
    jobId: row.id as string,
    message,
    at: ((row.completed_at ?? row.created_at) as Date | string | null)?.toString() ?? null,
  };
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
  /** 'on' = schedule enabled · 'paused' = auto-paused after failures · 'off' = none/disabled. */
  scheduleState: "off" | "on" | "paused";
  exists: boolean;
}

export async function getRailStats(projectId: string): Promise<RailStats> {
  const sql = hubSql();
  const projRows = await sql`
    SELECT client_name, website_url FROM projects WHERE id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  if (projRows.length === 0) {
    return { clientName: "", websiteUrl: "", pageCount: 0, needsWork: 0, competitorCount: 0, brandActive: false, scheduleState: "off", exists: false };
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
  // scan_schedules is lazily created by lib/schedule/store — before its
  // first DDL run the query fails, which the catch reads as "no schedule".
  const schedRows = await sql`
    SELECT enabled, paused_reason FROM scan_schedules WHERE project_id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  const scheduleState: RailStats["scheduleState"] = schedRows[0]
    ? schedRows[0].enabled === true
      ? "on"
      : schedRows[0].paused_reason
        ? "paused"
        : "off"
    : "off";
  return {
    clientName: String(projRows[0].client_name ?? ""),
    websiteUrl: String(projRows[0].website_url ?? ""),
    pageCount,
    needsWork,
    competitorCount: (compRows[0]?.n as number) ?? 0,
    brandActive,
    scheduleState,
    exists: true,
  };
}

// ── Run-to-run comparison (2026-08-03) ────────────────────────
//
// "I re-ran the audit and can't tell if anything changed."
//
// Everything here is derived from stored scores — ZERO API cost.
// Two honesty rules are load-bearing:
//
//  1. Pages are matched across runs by NORMALISED URL, never by
//     page_id. A re-audit mints new audit_pages rows, so page ids
//     never survive a run (same trap as the packet-404 bug).
//  2. The all-pages average and the like-for-like average are
//     reported SEPARATELY. If the crawl found two new pages, the
//     headline average moved partly because the page set changed,
//     not because any page improved — collapsing those into one
//     number would be a lie the user can't see through.
//
// A zero delta here is a real finding, not a missing one: scoring
// is deterministic (temperature 0 + content_hash reuse), so an
// unchanged page reproduces its prior score exactly.

/** One page's score movement between two runs. */
export interface PageMove {
  url: string;
  prev: number;
  curr: number;
  /** curr − prev. Positive = improved. */
  delta: number;
}

export interface RunComparison {
  prevJobId: string;
  /** When the run we're comparing against completed. */
  prevRunAt: Date | null;
  /** All-pages average of the PREVIOUS run, rounded like the score ring. */
  prevAvg: number;
  /** All-pages average of the CURRENT run, rounded like the score ring. */
  currAvg: number;
  /** Pages scored in both runs. */
  compared: number;
  improved: number;
  declined: number;
  unchanged: number;
  /** Pages scored this run that weren't in the previous one. */
  added: number;
  /** Pages in the previous run that this run didn't score. */
  dropped: number;
  /** Average across the intersection only — null when nothing overlaps. */
  likeForLikeDelta: number | null;
  /** Biggest absolute movers, improved-first, max 3. */
  topMovers: PageMove[];
}

/**
 * Match a page across runs. Protocol, www, trailing slash and case
 * differences don't make it a different page.
 */
function pageKey(u: string): string {
  return u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function meanScore(scores: PageScore[]): number {
  if (scores.length === 0) return 0;
  return Math.round(scores.reduce((t, s) => t + s.overallScore, 0) / scores.length);
}

/**
 * Compare the current client run against the previous completed one.
 * Returns null when there is no earlier run to compare against — the
 * caller renders nothing rather than a "0 change" that implies a
 * comparison happened.
 */
export async function getRunComparison(
  projectId: string,
  currentJobId: string | undefined,
  currentScores: PageScore[]
): Promise<RunComparison | null> {
  if (!currentJobId || currentScores.length === 0) return null;
  const sql = hubSql();

  const jobs = await sql`
    SELECT id, completed_at FROM audit_jobs
    WHERE project_id = ${projectId}
      AND competitor_id IS NULL
      AND status = 'done'
    ORDER BY completed_at DESC NULLS LAST
    LIMIT 5
  `.catch(() => [] as Record<string, unknown>[]);

  // The run immediately older than the one on screen. The current job's own
  // position is located rather than assumed — and if it isn't in this window
  // at all we return null instead of falling back to jobs[1], because
  // comparing against the WRONG run is worse than showing no comparison.
  const idx = jobs.findIndex((j) => String(j.id) === currentJobId);
  if (idx < 0) return null;
  const prevRow = jobs[idx + 1];
  if (!prevRow) return null;

  const prevJobId = String(prevRow.id);
  const prevScores = await getScoresByJob(prevJobId).catch(() => [] as PageScore[]);
  if (prevScores.length === 0) return null;

  const prevByUrl = new Map(prevScores.map((s) => [pageKey(s.url), s]));
  const currKeys = new Set(currentScores.map((s) => pageKey(s.url)));

  let improved = 0;
  let declined = 0;
  let unchanged = 0;
  let added = 0;
  let prevSum = 0;
  let currSum = 0;
  const movers: PageMove[] = [];

  for (const s of currentScores) {
    const prior = prevByUrl.get(pageKey(s.url));
    if (!prior) {
      added++;
      continue;
    }
    const delta = s.overallScore - prior.overallScore;
    prevSum += prior.overallScore;
    currSum += s.overallScore;
    if (delta > 0) improved++;
    else if (delta < 0) declined++;
    else unchanged++;
    if (delta !== 0) {
      movers.push({ url: s.url, prev: prior.overallScore, curr: s.overallScore, delta });
    }
  }

  const compared = improved + declined + unchanged;
  const dropped = prevScores.filter((s) => !currKeys.has(pageKey(s.url))).length;

  // Sort by size of move, improvements ahead of declines at equal size, then
  // URL — so the same data always renders in the same order.
  movers.sort(
    (a, b) =>
      Math.abs(b.delta) - Math.abs(a.delta) ||
      b.delta - a.delta ||
      a.url.localeCompare(b.url)
  );

  return {
    prevJobId,
    prevRunAt: prevRow.completed_at ? new Date(prevRow.completed_at as string) : null,
    prevAvg: meanScore(prevScores),
    currAvg: meanScore(currentScores),
    compared,
    improved,
    declined,
    unchanged,
    added,
    dropped,
    likeForLikeDelta:
      compared > 0 ? Math.round((currSum - prevSum) / compared) : null,
    topMovers: movers.slice(0, 3),
  };
}
