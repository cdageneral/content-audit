// ─────────────────────────────────────────────────────────────
//  Traditional Google rankings rollup — Phase 1 (2026-07-31).
//
//  Surfaces the ORGANIC POSITIONS already sitting in the SERP
//  snapshots the AI-visibility pipeline stores on every scan
//  (serp_keywords.position, from DataForSEO ranked_keywords).
//  No new API calls happen here — this module only reads.
//
//  Data-honesty rules (Wayne's standing rule, non-negotiable):
//  · Observed positions only. No estimates, no interpolation.
//  · position = 0 means "no organic rank captured for this
//    keyword" — rendered as "—", excluded from averages and
//    distribution. It is NOT the same as "checked and absent".
//  · Volumes surface ONLY from volumes_semrush snapshots
//    (Google-Ads grouped volumes are never shown — see
//    feedback_search_volumes). Otherwise null → "—".
//  · Trend = one point per scan (job). Nothing between scans.
//  · Headline tiles exclude branded keywords, matching the
//    existing non-branded convention in getSerpRollup.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { ensureSerpSchema } from "@/lib/db/serp";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

/**
 * Quadrant = Google rank × AI-answer citation, per keyword.
 *  own       — top-10 organic AND cited in the AI answer (AIO or PAA)
 *  canwin    — top-10 organic, NOT cited (incl. SERPs with no AI answer yet)
 *  aifirst   — cited by AI while ranking outside the top 10 (or unranked)
 *  invisible — neither top-10 nor cited
 */
export type RankQuadrant = "own" | "canwin" | "aifirst" | "invisible";

export interface RankedKeywordRow {
  keyword: string;
  /** Best organic position this scan (0 = no organic rank captured). */
  position: number;
  /** Best organic position on the PREVIOUS scan with SERP data, if any. */
  prevPosition: number | null;
  /** prev − current, only when both scans captured a rank. +n = moved up. */
  delta: number | null;
  /** TRUE when this keyword first appeared in the latest scan. */
  isNew: boolean;
  /** Page that holds the best position (falls back to the snapshot page). */
  pageUrl: string;
  pageId: string | null;
  /** Monthly volume, or null when only grouped-era volumes exist. */
  volume: number | null;
  aioTriggered: boolean;
  aioCited: boolean;
  paaPresent: boolean;
  paaOwned: boolean;
  branded: boolean;
  /** An AI Overview or PAA box exists on this keyword's SERP. */
  aiPresent: boolean;
  /** A client URL is cited in the AI answer (AIO citation or PAA ownership). */
  cited: boolean;
  quad: RankQuadrant;
  /** Non-client domains cited in this keyword's AI Overview (rank order, ≤3). */
  aioWinners: string[];
}

export interface RankTrendPoint {
  jobId: string;
  /** ISO timestamp of the scan's SERP fetch. */
  date: string;
  /** Average organic position across ranked non-branded keywords, or null. */
  avgPosition: number | null;
  top10: number;
  tracked: number;
}

export interface RankRollup {
  jobId: string;
  fetchedAt: string;
  /** Distinct non-branded keywords in the latest scan's snapshots. */
  tracked: number;
  brandedCount: number;
  /** …of tracked, how many have an organic position captured. */
  ranked: number;
  avgPosition: number | null;
  prevAvgPosition: number | null;
  top10: number;
  prevTop10: number | null;
  top3: number;
  /** Positions 11–20 — one push from page 1. */
  striking: number;
  distribution: {
    top3: number;
    p410: number;
    p1120: number;
    p2150: number;
    p51: number;
    /** Keywords with no organic rank captured (NOT "checked & absent"). */
    unranked: number;
  };
  /** TRUE when at least one latest-scan snapshot carries Semrush volumes. */
  volumesOk: boolean;
  /** One point per scan, oldest → newest, last 12 scans. */
  trend: RankTrendPoint[];
  /** All latest-scan keywords (branded flagged, non-branded first). */
  keywords: RankedKeywordRow[];
  quadCounts: Record<RankQuadrant, number>;
  /** Of the canwin keywords, how many have NO AI answer on the SERP at all. */
  canwinNoAi: number;
}

interface KwAgg {
  bestPos: number; // 0 = none
  bestPageUrl: string;
  bestPageId: string | null;
  volume: number | null;
  aioTriggered: boolean;
  aioCited: boolean;
  paaPresent: boolean;
  paaOwned: boolean;
  branded: boolean;
}

/**
 * Aggregate one scan's keyword rows by keyword text. The same keyword can
 * appear under several page snapshots — the best (lowest non-zero) organic
 * position wins the pageUrl/pageId attribution; boolean flags OR together
 * so "any page cited" reads as cited at the keyword level.
 */
function aggregateJob(
  rows: Record<string, unknown>[],
  snapMeta: Map<string, { pageUrl: string; pageId: string | null; volumesOk: boolean }>
): Map<string, KwAgg> {
  const out = new Map<string, KwAgg>();
  for (const r of rows) {
    const meta = snapMeta.get(r.snapshot_id as string);
    if (!meta) continue;
    const key = String(r.keyword ?? "").trim().toLowerCase();
    if (!key) continue;
    const pos = Number(r.position ?? 0) || 0;
    const vol = meta.volumesOk ? Number(r.volume ?? 0) || 0 : null;
    const agg = out.get(key) ?? {
      bestPos: 0,
      bestPageUrl: meta.pageUrl,
      bestPageId: meta.pageId,
      volume: null,
      aioTriggered: false,
      aioCited: false,
      paaPresent: false,
      paaOwned: false,
      branded: false,
    };
    if (pos > 0 && (agg.bestPos === 0 || pos < agg.bestPos)) {
      agg.bestPos = pos;
      agg.bestPageUrl = meta.pageUrl;
      agg.bestPageId = meta.pageId;
    }
    if (vol !== null && (agg.volume === null || vol > agg.volume)) agg.volume = vol;
    agg.aioTriggered = agg.aioTriggered || Boolean(r.aio_triggered);
    agg.aioCited = agg.aioCited || Boolean(r.aio_cited);
    agg.paaPresent = agg.paaPresent || Boolean(r.paa_present);
    agg.paaOwned = agg.paaOwned || Boolean(r.paa_owned);
    agg.branded = agg.branded || Boolean(r.branded);
    out.set(key, agg);
  }
  return out;
}

function trendPoint(jobId: string, date: string, aggs: Map<string, KwAgg>): RankTrendPoint {
  let sum = 0;
  let ranked = 0;
  let top10 = 0;
  let tracked = 0;
  aggs.forEach((a) => {
    if (a.branded) return;
    tracked++;
    if (a.bestPos > 0) {
      ranked++;
      sum += a.bestPos;
      if (a.bestPos <= 10) top10++;
    }
  });
  return {
    jobId,
    date,
    avgPosition: ranked > 0 ? Math.round((sum / ranked) * 10) / 10 : null,
    top10,
    tracked,
  };
}

/**
 * Rank rollup for a project's latest client scan with SERP data, plus a
 * per-scan trend over the last 12 scans. Returns null when no client job
 * has snapshots yet.
 */
export async function getRankRollup(projectId: string): Promise<RankRollup | null> {
  await ensureSerpSchema();
  const sql = db();

  // Scans (client jobs) that have SERP snapshots, oldest → newest.
  const jobs = await sql`
    SELECT s.job_id, MIN(s.fetched_at) AS fetched_at
    FROM serp_snapshots s
    JOIN audit_jobs j ON j.id = s.job_id
    WHERE s.project_id = ${projectId} AND j.competitor_id IS NULL
    GROUP BY s.job_id
    ORDER BY MIN(s.fetched_at) ASC
  `.catch(() => [] as Record<string, unknown>[]);
  if (jobs.length === 0) return null;
  const recent = jobs.slice(-12);
  const jobIds = recent.map((j) => j.job_id as string);
  const latestJobId = jobIds[jobIds.length - 1];
  const prevJobId = jobIds.length > 1 ? jobIds[jobIds.length - 2] : null;

  const snaps = await sql`
    SELECT id, job_id, page_url, page_id, volumes_semrush
    FROM serp_snapshots WHERE job_id = ANY(${jobIds})
  `.catch(() => [] as Record<string, unknown>[]);
  if (snaps.length === 0) return null;
  const snapIds = snaps.map((s) => s.id as string);
  const snapMeta = new Map(
    snaps.map((s) => [
      s.id as string,
      {
        pageUrl: s.page_url as string,
        pageId: (s.page_id as string) ?? null,
        volumesOk: Boolean(s.volumes_semrush),
      },
    ])
  );
  const snapJob = new Map(snaps.map((s) => [s.id as string, s.job_id as string]));

  const kwRows = await sql`
    SELECT snapshot_id, keyword, position, volume, aio_triggered, aio_cited,
           paa_present, paa_owned, branded
    FROM serp_keywords WHERE snapshot_id = ANY(${snapIds})
  `.catch(() => [] as Record<string, unknown>[]);

  // AI Overview occupants for the LATEST scan only (who is cited instead).
  const latestSnapIds = snaps
    .filter((s) => s.job_id === latestJobId)
    .map((s) => s.id as string);
  const occRows = await sql`
    SELECT keyword, domain, is_client, rank
    FROM serp_occupants
    WHERE snapshot_id = ANY(${latestSnapIds}) AND feature = 52
    ORDER BY rank ASC
  `.catch(() => [] as Record<string, unknown>[]);
  const occByKw = new Map<string, { winners: string[]; clientCited: boolean }>();
  for (const o of occRows) {
    const key = String(o.keyword ?? "").trim().toLowerCase();
    if (!key) continue;
    const e = occByKw.get(key) ?? { winners: [], clientCited: false };
    if (o.is_client) e.clientCited = true;
    else {
      const dom = String(o.domain ?? "");
      if (dom && e.winners.length < 3 && e.winners.indexOf(dom) === -1) e.winners.push(dom);
    }
    occByKw.set(key, e);
  }

  // Group keyword rows by job, then aggregate per keyword.
  const rowsByJob = new Map<string, Record<string, unknown>[]>();
  for (const r of kwRows) {
    const jid = snapJob.get(r.snapshot_id as string);
    if (!jid) continue;
    const arr = rowsByJob.get(jid) ?? [];
    arr.push(r);
    rowsByJob.set(jid, arr);
  }
  const aggByJob = new Map<string, Map<string, KwAgg>>();
  for (const jid of jobIds) {
    aggByJob.set(jid, aggregateJob(rowsByJob.get(jid) ?? [], snapMeta));
  }

  const trend: RankTrendPoint[] = recent.map((j) =>
    trendPoint(j.job_id as string, String(j.fetched_at), aggByJob.get(j.job_id as string)!)
  );

  const latest = aggByJob.get(latestJobId)!;
  const prev = prevJobId ? aggByJob.get(prevJobId)! : null;

  const keywords: RankedKeywordRow[] = [];
  const quadCounts: Record<RankQuadrant, number> = { own: 0, canwin: 0, aifirst: 0, invisible: 0 };
  let canwinNoAi = 0;
  const dist = { top3: 0, p410: 0, p1120: 0, p2150: 0, p51: 0, unranked: 0 };
  let tracked = 0;
  let brandedCount = 0;
  let ranked = 0;
  let posSum = 0;
  let top10 = 0;
  let top3 = 0;
  let striking = 0;

  latest.forEach((a, key) => {
    const occ = occByKw.get(key);
    const cited = a.aioCited || a.paaOwned || Boolean(occ?.clientCited);
    const aiPresent = a.aioTriggered || a.paaPresent;
    const topTen = a.bestPos >= 1 && a.bestPos <= 10;
    const quad: RankQuadrant = cited
      ? topTen
        ? "own"
        : "aifirst"
      : topTen
        ? "canwin"
        : "invisible";

    const prevAgg = prev?.get(key);
    const prevPos = prevAgg && prevAgg.bestPos > 0 ? prevAgg.bestPos : null;
    const delta = prevPos !== null && a.bestPos > 0 ? prevPos - a.bestPos : null;

    keywords.push({
      keyword: key,
      position: a.bestPos,
      prevPosition: prevPos,
      delta,
      isNew: prev !== null && !prev.has(key),
      pageUrl: a.bestPageUrl,
      pageId: a.bestPageId,
      volume: a.volume,
      aioTriggered: a.aioTriggered,
      aioCited: a.aioCited,
      paaPresent: a.paaPresent,
      paaOwned: a.paaOwned,
      branded: a.branded,
      aiPresent,
      cited,
      quad,
      aioWinners: occ?.winners ?? [],
    });

    if (a.branded) {
      brandedCount++;
      return; // headline tiles + quadrants are non-branded, matching getSerpRollup
    }
    tracked++;
    quadCounts[quad]++;
    if (quad === "canwin" && !aiPresent) canwinNoAi++;
    if (a.bestPos === 0) dist.unranked++;
    else {
      ranked++;
      posSum += a.bestPos;
      if (a.bestPos <= 3) dist.top3++;
      else if (a.bestPos <= 10) dist.p410++;
      else if (a.bestPos <= 20) dist.p1120++;
      else if (a.bestPos <= 50) dist.p2150++;
      else dist.p51++;
      if (a.bestPos <= 10) top10++;
      if (a.bestPos <= 3) top3++;
      if (a.bestPos >= 11 && a.bestPos <= 20) striking++;
    }
  });

  // Deterministic default order: ranked positions ascending, unranked last,
  // alphabetical tiebreak. Never volume-ordered unless volumes are real —
  // and even then the client component sorts explicitly.
  keywords.sort((a, b) => {
    if (a.branded !== b.branded) return a.branded ? 1 : -1;
    const ap = a.position > 0 ? a.position : 9999;
    const bp = b.position > 0 ? b.position : 9999;
    return ap - bp || a.keyword.localeCompare(b.keyword);
  });

  const prevPoint = trend.length > 1 ? trend[trend.length - 2] : null;
  const volumesOk = snaps.some((s) => s.job_id === latestJobId && Boolean(s.volumes_semrush));

  return {
    jobId: latestJobId,
    fetchedAt: String(recent[recent.length - 1].fetched_at),
    tracked,
    brandedCount,
    ranked,
    avgPosition: ranked > 0 ? Math.round((posSum / ranked) * 10) / 10 : null,
    prevAvgPosition: prevPoint?.avgPosition ?? null,
    top10,
    prevTop10: prevPoint ? prevPoint.top10 : null,
    top3,
    striking,
    distribution: dist,
    volumesOk,
    trend,
    keywords,
    quadCounts,
    canwinNoAi,
  };
}
