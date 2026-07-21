"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type {
  AuditJob,
  PageScore,
  AuditSummary,
  ScoreDimension,
  IntentBucket,
} from "@/lib/types";
import {
  DIMENSION_LABELS,
  ALL_BUCKETS,
  BUCKET_LABELS,
  BUCKET_DESCRIPTIONS,
  isAiFetchLikely,
  AI_FETCH_READINESS_BAR,
} from "@/lib/types";
import InfoTip from "@/components/InfoTip";
import type { PageOptimizeState } from "@/lib/db/drafts";

const BUCKET_COLORS: Record<IntentBucket, string> = {
  recency: "#d97706",     // amber — time-sensitive
  ranking: "#6366f1",     // indigo — best-of lists
  local: "#059669",       // emerald — location intent
  comparison: "#0284c7",  // sky — head-to-head
};

export interface CompetitorPageEntry {
  competitorName: string;
  color: string;
  url: string;
  score: number;
  grade: "A" | "B" | "C" | "D" | "F";
}

interface Props {
  job: AuditJob;
  scores: PageScore[];
  summary: AuditSummary;
  /** Flattened competitor pages (all competitors) for the "outperforming" card. */
  competitorPages?: CompetitorPageEntry[];
  /**
   * When set, each CLIENT page row gets an "Optimize" button linking to the
   * per-URL optimize workbench. Competitor pages never get one — you can't
   * edit someone else's content; they're the benchmark instead.
   */
  projectId?: string;
  /**
   * Project audit-source config — enables the per-page "remove from next run"
   * checkboxes. Hidden for single-page projects (nothing to prune).
   */
  auditSource?: "domain" | "single" | "list";
  sourceUrls?: string[] | null;
  /**
   * Per-URL optimization state (saved draft / simulated score / verification),
   * keyed by full page URL. Read-only surfacing of Optimize-workbench work —
   * drives the row badges. Absent on views with no optimize context.
   */
  optimizeStates?: Record<string, PageOptimizeState>;
}

export default function AuditResults({ job, scores, summary, competitorPages = [], projectId, auditSource, sourceUrls, optimizeStates }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"overallScore" | ScoreDimension>("overallScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedPage, setSelectedPage] = useState<PageScore | null>(null);
  const [bucketFilter, setBucketFilter] = useState<IntentBucket | null>(null);
  // Instant hover tooltip for the Query Type dots (native title tooltips are
  // delayed/unreliable). Portaled to <body>: the results section sits inside
  // an anim-fade-up container whose transform re-anchors position:fixed.
  const [dotTip, setDotTip] = useState<{ x: number; y: number; label: string } | null>(null);

  // ── Per-page "remove from next run" selection ───────────────────────────
  // Pruning converts the project's client URL set to an explicit list minus
  // the selected pages (PATCH /api/projects/[id]) — nothing runs now, and
  // past results are untouched. Hidden for single-page projects.
  const canPrune = !!projectId && auditSource != null && auditSource !== "single" && scores.length > 1;
  const [removeSet, setRemoveSet] = useState<Set<string>>(new Set());
  const [removeState, setRemoveState] = useState<"idle" | "confirm" | "saving" | "error">("idle");
  const baseUrls =
    auditSource === "list" && sourceUrls?.length
      ? sourceUrls
      : Array.from(new Set(scores.map((s) => s.url)));
  const remainingCount = baseUrls.filter((u) => !removeSet.has(u)).length;

  function toggleRemove(url: string) {
    setRemoveSet((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
    setRemoveState("idle");
  }

  async function confirmRemove() {
    if (!projectId) return;
    setRemoveState("saving");
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auditSource: "list",
          sourceUrls: baseUrls.filter((u) => !removeSet.has(u)),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRemoveSet(new Set());
      setRemoveState("idle");
      router.refresh();
    } catch (err) {
      console.error("[remove-from-run] failed:", err);
      setRemoveState("error");
    }
  }

  // ── Summary-card data (all derived from real audit scores) ──────────────
  const clientAvg = scores.length
    ? Math.round(scores.reduce((s, p) => s + p.overallScore, 0) / scores.length)
    : 0;
  const strongest = [...scores].sort((a, b) => b.overallScore - a.overallScore).slice(0, 5);
  const weakest = [...scores].sort((a, b) => a.overallScore - b.overallScore).slice(0, 5);
  const outperforming = [...competitorPages]
    .filter((c) => c.score > clientAvg)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // ── Intent-bucket data (from LLM classification of page content) ────────
  const classifiedCount = scores.filter((s) => s.intentBuckets != null).length;
  const unclassifiedCount = scores.length - classifiedCount;
  const bucketCounts = Object.fromEntries(
    ALL_BUCKETS.map((b) => [
      b,
      scores.filter((s) => s.intentBuckets?.includes(b)).length,
    ])
  ) as Record<IntentBucket, number>;
  // "Likely to be fetched in an AI answer": fits ≥1 crawl-forcing bucket AND
  // retrievable/citable readiness clears the bar (see lib/types.ts).
  const fetchLikely = scores.filter((s) => isAiFetchLikely(s.intentBuckets, s.scores));
  const fetchPct = scores.length
    ? Math.round((fetchLikely.length / scores.length) * 100)
    : 0;

  const filtered = scores
    .filter((s) => s.url.toLowerCase().includes(search.toLowerCase()))
    .filter((s) => (bucketFilter ? s.intentBuckets?.includes(bucketFilter) ?? false : true))
    .sort((a, b) => {
      const va = sortKey === "overallScore" ? a.overallScore : a.scores[sortKey];
      const vb = sortKey === "overallScore" ? b.overallScore : b.scores[sortKey];
      return sortDir === "desc" ? vb - va : va - vb;
    });

  const radarData = (Object.keys(DIMENSION_LABELS) as ScoreDimension[]).map((dim) => ({
    dimension: DIMENSION_LABELS[dim],
    score: summary.averageByDimension[dim],
  }));

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <StatCard
          label="Pages Audited"
          value={summary.totalPages.toString()}
          tip="How many pages were crawled and scored in the latest completed audit run for this site."
        />
        <StatCard
          label="Avg LLM Score"
          value={`${summary.averageScore}`}
          sub={`/ 100`}
          color={scoreColor(summary.averageScore)}
          tip="The average overall score (0–100) across all audited pages. Each page's overall score is a weighted blend of the 8 LLM-readiness dimensions."
        />
        <StatCard
          label="Top Issue"
          value={DIMENSION_LABELS[summary.topIssues[0]?.dimension]}
          sub={`avg ${summary.topIssues[0]?.averageScore}`}
          tip="The scoring dimension with the lowest average across your pages — usually the highest-leverage thing to fix first."
        />
        {/* AI fetch likelihood: % of pages that fit a crawl-forcing intent
            bucket AND clear the retrievable/citable readiness bar. */}
        <div
          className="rounded-xl border border-slate-200 bg-white p-4"
          title={`Pages matching a crawl-forcing intent bucket with retrievable/citable average ≥ ${AI_FETCH_READINESS_BAR}`}
        >
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1.5">
            Likely AI Fetch
            <InfoTip
              title="Likely AI Fetch"
              text={`Percent of pages that both match a crawl-forcing intent (recency, ranking, local, or comparison) AND are retrieval-ready (retrievable/citable average of ${AI_FETCH_READINESS_BAR}+). These are the pages most plausibly fetched and used by AI answer engines like ChatGPT search or Google AI Overviews.`}
            />
          </p>
          {classifiedCount === 0 ? (
            <>
              <p className="text-2xl font-bold text-slate-300">—</p>
              <p className="text-xs text-slate-400 mt-0.5">Classify pages to compute</p>
            </>
          ) : (
            <>
              <p
                className="text-2xl font-bold"
                style={{ color: fetchPct >= 50 ? "#059669" : fetchPct >= 25 ? "#d97706" : "#dc2626" }}
              >
                {fetchPct}%
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {fetchLikely.length} of {scores.length} pages
                {unclassifiedCount > 0 ? ` · ${unclassifiedCount} unclassified` : ""}
              </p>
            </>
          )}
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            Grades
            <InfoTip
              title="Grades"
              text="How many pages earned each letter grade, based on their overall score: A 85–100, B 70–84, C 55–69, D 40–54, F below 40."
            />
          </p>
          <div className="flex gap-2 flex-wrap">
            {(["A", "B", "C", "D", "F"] as const).map((g) => (
              <span key={g} className={`grade-${g} rounded-md px-2 py-0.5 text-xs font-bold`}>
                {g}: {summary.gradeDistribution[g] ?? 0}
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* Radar + Top/Bottom */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Radar */}
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
            Score by Dimension
            <InfoTip
              title="Score by Dimension"
              text="Your site's average score on each of the 8 LLM-readiness dimensions. The fuller the shape, the stronger the site — dents show where AI systems struggle with your content."
            />
          </h3>
          <ResponsiveContainer width="100%" height={260}>
            <RadarChart data={radarData}>
              <PolarGrid stroke="#e2e8f0" />
              <PolarAngleAxis
                dataKey="dimension"
                tick={{ fill: "#64748b", fontSize: 10 }}
              />
              <Radar
                name="Score"
                dataKey="score"
                stroke="#6366f1"
                fill="#6366f1"
                fillOpacity={0.25}
              />
              <Tooltip
                contentStyle={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 8 }}
                labelStyle={{ color: "#0f172a" }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Top issues */}
        <div className="rounded-xl border border-slate-200 bg-white p-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
            Top Issues to Fix
            <InfoTip
              title="Top Issues to Fix"
              text="Your four lowest-scoring dimensions, with how many pages fall below 50 on each. Fixing these sitewide moves the average score fastest."
            />
          </h3>
          {summary.topIssues.map((issue) => (
            <div key={issue.dimension} className="flex items-center gap-3">
              <div className="w-full">
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-slate-700">
                    {DIMENSION_LABELS[issue.dimension]}
                  </span>
                  <span className="text-xs font-mono text-slate-500">
                    avg {issue.averageScore} · {issue.affectedPages} pages &lt; 50
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${issue.averageScore}%`,
                      background: scoreBgGradient(issue.averageScore),
                    }}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Summary cards: strongest / weakest / competitors outperforming */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <RankCard
          title="Top 5 Strongest Pages"
          tip="Your highest-scoring pages. Use them as internal templates — their structure and style are what the scoring engine rewards."
          rows={strongest.map((p) => ({ url: p.url, score: p.overallScore, grade: p.grade }))}
          onRowClick={(url) => setSelectedPage(scores.find((s) => s.url === url) ?? null)}
          emptyText="No pages scored yet."
        />
        <RankCard
          title="Top 5 Weakest Pages"
          tip="Your lowest-scoring pages — the best candidates for the Optimize workbench, where you can rewrite, simulate, and re-score them."
          rows={weakest.map((p) => ({ url: p.url, score: p.overallScore, grade: p.grade }))}
          onRowClick={(url) => setSelectedPage(scores.find((s) => s.url === url) ?? null)}
          emptyText="No pages scored yet."
        />
        <RankCard
          title="Competitors Outperforming You"
          tip="Competitor pages scoring above your site's average. These set the bar — click a row to see the page, then beat it with the Optimize workbench."
          subtitle={`Beating your avg of ${clientAvg}`}
          rows={outperforming.map((c) => ({
            url: c.url,
            score: c.score,
            delta: c.score - clientAvg,
            tag: c.competitorName,
            tagColor: c.color,
          }))}
          emptyText={
            competitorPages.length === 0
              ? "No competitor pages to compare yet."
              : "No competitor pages are beating your average — you're setting the pace."
          }
        />
      </div>

      {/* Intent-bucket cards: crawl-forcing query categories */}
      <div>
        <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
          <div>
            <h3 className="text-sm font-semibold text-slate-700">
              Crawl-Forcing Intent Buckets
            </h3>
            <p className="text-xs text-slate-400">
              Query categories that force AI answer engines to fetch live content — click a
              bucket to filter the pages below.
              {classifiedCount > 0 && unclassifiedCount === 0 && " Based on full-content analysis of every page."}
            </p>
          </div>
          {unclassifiedCount > 0 && (
            <ClassifyButton jobId={job.id} unclassifiedCount={unclassifiedCount} />
          )}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {ALL_BUCKETS.map((b) => {
            const active = bucketFilter === b;
            const count = bucketCounts[b];
            const pct = scores.length ? Math.round((count / scores.length) * 100) : 0;
            return (
              <button
                key={b}
                onClick={() => setBucketFilter(active ? null : b)}
                className={`text-left rounded-xl border p-4 transition-all ${
                  active
                    ? "border-indigo-400 bg-indigo-50 ring-1 ring-indigo-300"
                    : "border-slate-200 bg-white hover:border-indigo-200 hover:bg-slate-50"
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold uppercase tracking-wide" style={{ color: BUCKET_COLORS[b] }}>
                    {BUCKET_LABELS[b]}
                  </span>
                  {active && <span className="text-xs text-indigo-600 font-medium">filtering ×</span>}
                </div>
                <p className="text-2xl font-bold text-slate-900">
                  {count}
                  <span className="text-sm text-slate-400 font-medium ml-1.5">
                    {classifiedCount > 0 ? `${pct}%` : ""}
                  </span>
                </p>
                <p className="text-xs text-slate-400 mt-1 leading-snug">
                  {BUCKET_DESCRIPTIONS[b]}
                </p>
              </button>
            );
          })}
        </div>
        {classifiedCount > 0 && (
          <p className="text-xs text-slate-400 mt-2">
            {scores.filter((s) => s.intentBuckets != null && s.intentBuckets.length === 0).length}{" "}
            page(s) fit no bucket (evergreen/other)
            {unclassifiedCount > 0 ? ` · ${unclassifiedCount} not yet classified` : ""}. Pages can
            appear in more than one bucket.
          </p>
        )}
      </div>

      {/* Page table */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="p-4 border-b border-slate-200 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-700 flex-1">
            All Pages
            {bucketFilter && (
              <button
                onClick={() => setBucketFilter(null)}
                className="ml-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium border transition-colors hover:opacity-80"
                style={{
                  color: BUCKET_COLORS[bucketFilter],
                  borderColor: BUCKET_COLORS[bucketFilter],
                  background: `${BUCKET_COLORS[bucketFilter]}14`,
                }}
              >
                {BUCKET_LABELS[bucketFilter]} · {filtered.length} ×
              </button>
            )}
          </h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by URL…"
            className="rounded-lg border border-slate-300 bg-slate-100 px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none w-64"
          />
        </div>

        {/* Remove-from-next-run action bar */}
        {canPrune && removeSet.size > 0 && (
          <div className="px-4 py-2.5 border-b border-amber-200 bg-amber-50 flex items-center gap-3 flex-wrap">
            {removeState === "confirm" || removeState === "saving" ? (
              <>
                <p className="text-xs text-amber-800 flex-1 min-w-[240px]">
                  {auditSource === "domain"
                    ? `This switches the project to URL-list mode with the remaining ${remainingCount} page${remainingCount !== 1 ? "s" : ""} — future runs audit exactly that list and won't discover new pages. `
                    : `Future runs will audit the remaining ${remainingCount} page${remainingCount !== 1 ? "s" : ""}. `}
                  Past results and trends are kept. Applies from the next run.
                </p>
                <button
                  onClick={() => setRemoveState("idle")}
                  disabled={removeState === "saving"}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Back
                </button>
                <button
                  onClick={confirmRemove}
                  disabled={removeState === "saving"}
                  className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-500 transition-colors"
                >
                  {removeState === "saving" ? "Saving…" : `Confirm — remove ${removeSet.size}`}
                </button>
              </>
            ) : (
              <>
                <p className="text-xs text-amber-800 flex-1 min-w-[240px]">
                  {removeSet.size} page{removeSet.size !== 1 ? "s" : ""} selected
                  {removeState === "error" && (
                    <span className="text-red-600 font-medium"> — save failed, try again</span>
                  )}
                </p>
                <button
                  onClick={() => setRemoveSet(new Set())}
                  className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                >
                  Clear
                </button>
                <button
                  onClick={() => setRemoveState("confirm")}
                  disabled={remainingCount === 0}
                  title={remainingCount === 0 ? "At least one page must remain in the audit" : undefined}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-colors ${
                    remainingCount === 0 ? "bg-slate-300 cursor-not-allowed" : "bg-amber-600 hover:bg-amber-500"
                  }`}
                >
                  Remove from next run
                </button>
              </>
            )}
          </div>
        )}

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
                {canPrune && (
                  <th className="px-3 py-3 w-8">
                    <input
                      type="checkbox"
                      title="Select all shown"
                      aria-label="Select all shown pages"
                      className="accent-amber-600 cursor-pointer"
                      checked={filtered.length > 0 && filtered.every((p) => removeSet.has(p.url))}
                      onChange={(e) => {
                        const next = new Set(removeSet);
                        if (e.target.checked) filtered.forEach((p) => next.add(p.url));
                        else filtered.forEach((p) => next.delete(p.url));
                        setRemoveSet(next);
                        setRemoveState("idle");
                      }}
                    />
                  </th>
                )}
                <th className="text-left px-4 py-3">URL</th>
                <th
                  className="text-left px-2 py-3"
                  title="Dot position = query type: 1 Recency · 2 Ranking · 3 Local · 4 Comparison"
                >
                  Query Type
                </th>
                <SortHeader label="Score" field="overallScore" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Intent" field="coreIntent" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Edges" field="edgeCases" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Retrieve" field="retrievable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Extract" field="extractable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Cite" field="citable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Reuse" field="reusable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <th className="px-4 py-3">Grade</th>
                {projectId && <th className="px-4 py-3" />}
              </tr>
            </thead>
            <tbody>
              {filtered.map((page) => (
                <tr
                  key={page.id}
                  onClick={() => setSelectedPage(page)}
                  className={`border-b border-slate-200/70 hover:bg-slate-50 cursor-pointer transition-colors ${
                    removeSet.has(page.url) ? "bg-amber-50/60" : ""
                  }`}
                >
                  {canPrune && (
                    <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        title="Remove this page from the next run"
                        aria-label={`Remove ${page.url} from the next run`}
                        className="accent-amber-600 cursor-pointer"
                        checked={removeSet.has(page.url)}
                        onChange={() => toggleRemove(page.url)}
                      />
                    </td>
                  )}
                  <td className="px-4 py-3 max-w-xs truncate text-slate-700 text-xs font-mono">
                    {page.url.replace(/^https?:\/\/[^/]+/, "")}
                  </td>
                  <td className="px-2 py-3">
                    {page.intentBuckets == null ? (
                      <span className="text-xs text-slate-300" title="Not yet classified">–</span>
                    ) : (
                      /* Fixed 4-slot layout — dot POSITION encodes the query
                         type (1 recency, 2 ranking, 3 local, 4 comparison),
                         so types align vertically down the column. Empty
                         slots keep a faint ring so the grid stays readable. */
                      <div className="flex items-center gap-1.5">
                        {ALL_BUCKETS.map((b) => {
                          const has = page.intentBuckets!.includes(b);
                          const primary = page.primaryBucket === b;
                          const tipLabel = has
                            ? `${BUCKET_LABELS[b]}${primary ? " (primary)" : ""}`
                            : `${BUCKET_LABELS[b]} — not detected`;
                          return (
                            <span
                              key={b}
                              aria-label={tipLabel}
                              onMouseEnter={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                setDotTip({ x: r.left + r.width / 2, y: r.top, label: tipLabel });
                              }}
                              onMouseLeave={() => setDotTip(null)}
                              className="inline-flex items-center justify-center flex-shrink-0"
                              style={{ width: 10, height: 10 }}
                            >
                              {has ? (
                                <span
                                  className="inline-block rounded-full"
                                  style={{
                                    width: primary ? 10 : 7,
                                    height: primary ? 10 : 7,
                                    background: BUCKET_COLORS[b],
                                  }}
                                />
                              ) : (
                                <span
                                  className="inline-block rounded-full"
                                  style={{
                                    width: 6,
                                    height: 6,
                                    border: "1px solid #e2e8f0",
                                    background: "transparent",
                                  }}
                                />
                              )}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 font-bold" style={{ color: scoreColor(page.overallScore) }}>
                    {page.overallScore}
                  </td>
                  {(["coreIntent", "edgeCases", "retrievable", "extractable", "citable", "reusable"] as ScoreDimension[]).map((d) => (
                    <td key={d} className="px-4 py-3 text-slate-500 text-xs">
                      <ScoreChip score={page.scores[d]} />
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <span className={`grade-${page.grade} rounded px-2 py-0.5 text-xs font-bold`}>
                      {page.grade}
                    </span>
                  </td>
                  {projectId && (
                    <td className="px-4 py-3">
                      <div
                        className="flex flex-col items-end gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {optimizeStates?.[page.url] && (
                          <OptBadge baseline={page.overallScore} st={optimizeStates[page.url]} />
                        )}
                        <a
                          href={`/projects/${projectId}/optimize/${page.pageId}`}
                          className="inline-block rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors whitespace-nowrap"
                        >
                          {optimizeStates?.[page.url] ? "Review" : "Optimize"}
                        </a>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Query Type dot tooltip (portaled to body — see dotTip comment) */}
      {dotTip && typeof document !== "undefined" && createPortal(
        <div
          className="fixed z-50 pointer-events-none"
          style={{ left: dotTip.x, top: dotTip.y - 8, transform: "translate(-50%, -100%)" }}
        >
          <span
            className="rounded-md px-2 py-1 text-[11px] font-medium text-white whitespace-nowrap shadow-lg"
            style={{ background: "#0f172a" }}
          >
            {dotTip.label}
          </span>
        </div>,
        document.body
      )}

      {/* Page detail drawer */}
      {selectedPage && (
        <PageDetail
          page={selectedPage}
          onClose={() => setSelectedPage(null)}
          optimizeHref={
            projectId ? `/projects/${projectId}/optimize/${selectedPage.pageId}` : undefined
          }
          optState={projectId ? optimizeStates?.[selectedPage.url] : undefined}
        />
      )}
    </div>
  );
}

function SortHeader({
  label,
  field,
  current,
  dir,
  onSort,
}: {
  label: string;
  field: string;
  current: string;
  dir: "asc" | "desc";
  onSort: (f: string) => void;
}) {
  const active = field === current;
  return (
    <th
      className="px-4 py-3 cursor-pointer hover:text-slate-700 transition-colors select-none"
      onClick={() => onSort(field)}
    >
      {label} {active ? (dir === "desc" ? "↓" : "↑") : ""}
    </th>
  );
}

function toggleSort(
  field: string,
  current: string,
  dir: "asc" | "desc",
  setKey: (k: "overallScore" | ScoreDimension) => void,
  setDir: (d: "asc" | "desc") => void
) {
  if (field === current) {
    setDir(dir === "desc" ? "asc" : "desc");
  } else {
    setKey(field as "overallScore" | ScoreDimension);
    setDir("desc");
  }
}

function ScoreChip({ score }: { score: number }) {
  return (
    <span style={{ color: scoreColor(score) }} className="font-mono font-medium">
      {score}
    </span>
  );
}

/**
 * Compact optimization badge shown on a page row: the latest simulated score,
 * its delta vs the current live score, and verification state. Baseline is the
 * row's current audit score so the delta always reads "what publishing gains
 * you now" — it stays honest even after a re-audit.
 */
function OptBadge({ baseline, st }: { baseline: number; st: PageOptimizeState }) {
  const sim = st.simulatedOverall;
  const d = sim != null ? sim - baseline : null;
  const verifiedOk = st.verified && st.verifiedMatched === true;
  const verifiedBad = st.verified && st.verifiedMatched === false;

  const tip =
    `Draft v${st.version}${st.draftCount > 1 ? ` · ${st.draftCount} versions` : ""} saved. ` +
    (sim != null
      ? `Simulated ${sim}${st.simulatedGrade ? ` (${st.simulatedGrade})` : ""}, ${
          d! >= 0 ? "+" : ""
        }${d} vs current ${baseline}. `
      : "Not yet simulated. ") +
    (verifiedOk
      ? "Published & verified — live score matched the simulation."
      : verifiedBad
      ? "Verified: the published page didn't match this draft."
      : "Not yet published/verified.");

  const deltaColor = d == null ? "#64748b" : d > 0 ? "#059669" : d < 0 ? "#dc2626" : "#64748b";

  return (
    <span
      title={tip}
      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-semibold leading-none"
    >
      {sim != null ? (
        <>
          <span className="text-slate-400 font-medium">sim</span>
          <span style={{ color: scoreColor(sim) }}>{sim}</span>
          {d != null && (
            <span style={{ color: deltaColor }}>
              {d > 0 ? `▲+${d}` : d < 0 ? `▼${d}` : "±0"}
            </span>
          )}
        </>
      ) : (
        <span className="text-slate-500">Draft v{st.version}</span>
      )}
      {verifiedOk && (
        <span style={{ color: "#059669" }} aria-label="Verified">
          ✓
        </span>
      )}
      {verifiedBad && (
        <span style={{ color: "#d97706" }} aria-label="Verification mismatch">
          ⚠
        </span>
      )}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  color,
  tip,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
  tip?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1 flex items-center gap-1.5">
        {label}
        {tip && <InfoTip title={label} text={tip} />}
      </p>
      <p className="text-2xl font-bold" style={{ color: color ?? "var(--text-1)" }}>
        {value}
        {sub && <span className="text-sm text-slate-500 ml-1">{sub}</span>}
      </p>
    </div>
  );
}

interface RankRow {
  url: string;
  score: number;
  grade?: "A" | "B" | "C" | "D" | "F";
  delta?: number;
  tag?: string;
  tagColor?: string;
}

function RankCard({
  title,
  subtitle,
  rows,
  onRowClick,
  emptyText,
  tip,
}: {
  title: string;
  subtitle?: string;
  rows: RankRow[];
  onRowClick?: (url: string) => void;
  emptyText: string;
  tip?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
          {title}
          {tip && <InfoTip title={title} text={tip} />}
        </h3>
        {subtitle && <p className="text-xs text-slate-400 mt-0.5">{subtitle}</p>}
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-slate-400 py-2">{emptyText}</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div
              key={`${r.url}-${i}`}
              onClick={onRowClick ? () => onRowClick(r.url) : undefined}
              className={`flex items-center gap-2 rounded-lg px-2 py-1.5 ${
                onRowClick ? "hover:bg-slate-50 cursor-pointer" : ""
              } transition-colors`}
            >
              <span className="text-xs text-slate-400 font-mono w-4 flex-shrink-0">{i + 1}</span>
              <div className="min-w-0 flex-1">
                {r.tag && (
                  <div className="flex items-center gap-1.5 mb-0.5">
                    {r.tagColor && (
                      <span
                        className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                        style={{ background: r.tagColor }}
                      />
                    )}
                    <span className="text-xs font-medium text-slate-600 truncate">{r.tag}</span>
                  </div>
                )}
                <p className="text-xs font-mono text-slate-500 truncate">
                  {r.url.replace(/^https?:\/\/[^/]+/, "") || r.url}
                </p>
              </div>
              {r.delta != null && (
                <span className="text-xs font-semibold text-emerald-600 flex-shrink-0">
                  +{r.delta}
                </span>
              )}
              <span
                className="text-sm font-bold flex-shrink-0"
                style={{ color: scoreColor(r.score) }}
              >
                {r.score}
              </span>
              {r.grade && (
                <span className={`grade-${r.grade} rounded px-1.5 py-0.5 text-xs font-bold flex-shrink-0`}>
                  {r.grade}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * "Classify pages" backfill button: dispatches classification-only batches
 * for pages that predate intent bucketing, polls progress, then reloads.
 */
function ClassifyButton({
  jobId,
  unclassifiedCount,
}: {
  jobId: string;
  unclassifiedCount: number;
}) {
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [progress, setProgress] = useState<string>("");

  async function start() {
    setState("running");
    setProgress("Dispatching…");
    try {
      const res = await fetch(`/api/audit/${jobId}/classify`, { method: "POST" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { total } = (await res.json()) as { total: number };

      // Poll until every score row is classified (or ~4 min passes), then
      // reload so the server-rendered cards pick up the new bucket data.
      const deadline = Date.now() + 240_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await fetch(`/api/audit/${jobId}/classify?t=${Date.now()}`);
        if (!s.ok) continue;
        const { total: t, classified } = (await s.json()) as {
          total: number;
          classified: number;
        };
        setProgress(`${classified}/${t || total} classified…`);
        if (t > 0 && classified >= t) break;
      }
      window.location.reload();
    } catch (err) {
      console.error("[classify] backfill failed:", err);
      setState("error");
    }
  }

  if (state === "error") {
    return (
      <button
        onClick={start}
        className="rounded-lg border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
      >
        Classification failed — retry
      </button>
    );
  }

  if (state === "running") {
    return (
      <span className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs text-slate-500">
        <span className="inline-block w-3 h-3 mr-1.5 align-[-2px] rounded-full border-2 border-indigo-500 border-t-transparent animate-spin" />
        {progress || "Classifying…"}
      </span>
    );
  }

  return (
    <button
      onClick={start}
      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors"
    >
      Classify {unclassifiedCount} page{unclassifiedCount !== 1 ? "s" : ""}
    </button>
  );
}

function PageDetail({
  page,
  onClose,
  optimizeHref,
  optState,
}: {
  page: PageScore;
  onClose: () => void;
  optimizeHref?: string;
  optState?: PageOptimizeState;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-300 bg-white p-6 space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500 font-mono mb-1">{page.url}</p>
            <div className="flex items-center gap-2">
              <span className={`grade-${page.grade} rounded px-2 py-0.5 text-sm font-bold`}>
                {page.grade}
              </span>
              <span className="text-slate-900 text-lg font-bold">{page.overallScore}/100</span>
              {optimizeHref && (
                <a
                  href={optimizeHref}
                  className="ml-2 rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors"
                >
                  ✦ Optimize this page
                </a>
              )}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-900 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {optState && (
          <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2 text-xs text-slate-600 flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-indigo-700">Optimization in progress</span>
            <span className="text-slate-400">·</span>
            <span>
              Draft v{optState.version}
              {optState.draftCount > 1 ? ` (${optState.draftCount} versions)` : ""} saved
            </span>
            {optState.simulatedOverall != null && (
              <>
                <span className="text-slate-400">·</span>
                <span>
                  simulated{" "}
                  <span className="font-bold" style={{ color: scoreColor(optState.simulatedOverall) }}>
                    {optState.simulatedOverall}
                  </span>
                  {(() => {
                    const d = optState.simulatedOverall! - page.overallScore;
                    return (
                      <span
                        className="ml-1 font-semibold"
                        style={{ color: d > 0 ? "#059669" : d < 0 ? "#dc2626" : "#64748b" }}
                      >
                        ({d >= 0 ? "+" : ""}{d} vs current {page.overallScore})
                      </span>
                    );
                  })()}
                </span>
              </>
            )}
            {optState.verified && optState.verifiedMatched === true && (
              <span className="font-semibold" style={{ color: "#059669" }}>· ✓ verified</span>
            )}
            {optState.verified && optState.verifiedMatched === false && (
              <span className="font-semibold" style={{ color: "#d97706" }}>· ⚠ verify mismatch</span>
            )}
          </div>
        )}

        {page.intentBuckets != null && (
          <div className="space-y-2">
            <h4 className="text-sm font-semibold text-slate-900">Intent Buckets</h4>
            {page.intentBuckets.length === 0 ? (
              <p className="text-xs text-slate-500">
                No crawl-forcing intent detected — evergreen/other content.
              </p>
            ) : (
              <div className="space-y-1.5">
                {page.intentBuckets.map((b) => (
                  <div key={b} className="flex items-start gap-2">
                    <span
                      className="mt-1 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: BUCKET_COLORS[b] }}
                    />
                    <div className="min-w-0">
                      <span className="text-xs font-semibold" style={{ color: BUCKET_COLORS[b] }}>
                        {BUCKET_LABELS[b]}
                        {page.primaryBucket === b && (
                          <span className="ml-1.5 text-slate-400 font-normal">primary</span>
                        )}
                      </span>
                      {page.bucketEvidence?.[b] && (
                        <p className="text-xs text-slate-500 italic">
                          &ldquo;{page.bucketEvidence[b]}&rdquo;
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="space-y-3">
          {(Object.keys(DIMENSION_LABELS) as ScoreDimension[]).map((dim) => (
            <div key={dim}>
              <div className="flex justify-between mb-1">
                <span className="text-sm text-slate-700">{DIMENSION_LABELS[dim]}</span>
                <span className="text-sm font-mono font-bold" style={{ color: scoreColor(page.scores[dim]) }}>
                  {page.scores[dim]}/100
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-slate-100">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${page.scores[dim]}%`, background: scoreBgGradient(page.scores[dim]) }}
                />
              </div>
              <p className="text-xs text-slate-500 mt-0.5">{page.rationale[dim]}</p>
            </div>
          ))}
        </div>

        {page.recommendations.length > 0 && (
          <div className="space-y-3 border-t border-slate-200 pt-4">
            <h4 className="text-sm font-semibold text-slate-900">Recommendations</h4>
            {page.recommendations.map((rec, i) => (
              <div
                key={i}
                className="rounded-lg bg-slate-100 border border-slate-200 p-3 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold uppercase ${priorityColor(rec.priority)}`}>
                    {rec.priority}
                  </span>
                  <span className="text-xs text-slate-500">
                    {DIMENSION_LABELS[rec.dimension]}
                  </span>
                </div>
                <p className="text-sm text-slate-700">{rec.suggestion}</p>
                {rec.example && (
                  <p className="text-xs text-slate-500 italic">{rec.example}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 80) return "#059669";
  if (score >= 65) return "#2563eb";
  if (score >= 50) return "#d97706";
  if (score >= 35) return "#ea580c";
  return "#dc2626";
}

function scoreBgGradient(score: number): string {
  if (score >= 80) return "#10b981";
  if (score >= 65) return "#3b82f6";
  if (score >= 50) return "#f59e0b";
  if (score >= 35) return "#f97316";
  return "#ef4444";
}

function priorityColor(p: string): string {
  return p === "critical"
    ? "text-red-600"
    : p === "high"
    ? "text-orange-600"
    : p === "medium"
    ? "text-amber-600"
    : "text-slate-500";
}
