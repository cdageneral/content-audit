"use client";

import { useState } from "react";
import {
  RadarChart,
  PolarGrid,
  PolarAngleAxis,
  Radar,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { AuditJob, PageScore, AuditSummary, ScoreDimension } from "@/lib/types";
import { DIMENSION_LABELS } from "@/lib/types";

interface Props {
  job: AuditJob;
  scores: PageScore[];
  summary: AuditSummary;
}

export default function AuditResults({ job, scores, summary }: Props) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<"overallScore" | ScoreDimension>("overallScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selectedPage, setSelectedPage] = useState<PageScore | null>(null);

  const filtered = scores
    .filter((s) => s.url.toLowerCase().includes(search.toLowerCase()))
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Pages Audited" value={summary.totalPages.toString()} />
        <StatCard
          label="Avg LLM Score"
          value={`${summary.averageScore}`}
          sub={`/ 100`}
          color={scoreColor(summary.averageScore)}
        />
        <StatCard
          label="Top Issue"
          value={DIMENSION_LABELS[summary.topIssues[0]?.dimension]}
          sub={`avg ${summary.topIssues[0]?.averageScore}`}
        />
        <div className="rounded-xl border border-slate-800 bg-[#161b27] p-4">
          <p className="text-xs text-slate-500 uppercase tracking-wide mb-2">Grades</p>
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
        <div className="rounded-xl border border-slate-800 bg-[#161b27] p-4">
          <h3 className="text-sm font-semibold text-slate-300 mb-3">Score by Dimension</h3>
          <ResponsiveContainer width="100%" height={260}>
            <RadarChart data={radarData}>
              <PolarGrid stroke="#1e2433" />
              <PolarAngleAxis
                dataKey="dimension"
                tick={{ fill: "#94a3b8", fontSize: 10 }}
              />
              <Radar
                name="Score"
                dataKey="score"
                stroke="#6366f1"
                fill="#6366f1"
                fillOpacity={0.25}
              />
              <Tooltip
                contentStyle={{ background: "#161b27", border: "1px solid #334155" }}
                labelStyle={{ color: "#e2e8f0" }}
              />
            </RadarChart>
          </ResponsiveContainer>
        </div>

        {/* Top issues */}
        <div className="rounded-xl border border-slate-800 bg-[#161b27] p-4 space-y-3">
          <h3 className="text-sm font-semibold text-slate-300">Top Issues to Fix</h3>
          {summary.topIssues.map((issue) => (
            <div key={issue.dimension} className="flex items-center gap-3">
              <div className="w-full">
                <div className="flex justify-between mb-1">
                  <span className="text-xs text-slate-300">
                    {DIMENSION_LABELS[issue.dimension]}
                  </span>
                  <span className="text-xs font-mono text-slate-400">
                    avg {issue.averageScore} · {issue.affectedPages} pages &lt; 50
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[#0f1117] overflow-hidden">
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

      {/* Page table */}
      <div className="rounded-xl border border-slate-800 bg-[#161b27] overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center gap-3">
          <h3 className="text-sm font-semibold text-slate-300 flex-1">All Pages</h3>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by URL…"
            className="rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none w-64"
          />
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-xs text-slate-500 uppercase tracking-wide">
                <th className="text-left px-4 py-3">URL</th>
                <SortHeader label="Score" field="overallScore" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Intent" field="coreIntent" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Edges" field="edgeCases" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Retrieve" field="retrievable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Extract" field="extractable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Cite" field="citable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <SortHeader label="Reuse" field="reusable" current={sortKey} dir={sortDir} onSort={(f) => toggleSort(f, sortKey, sortDir, setSortKey, setSortDir)} />
                <th className="px-4 py-3">Grade</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((page) => (
                <tr
                  key={page.id}
                  onClick={() => setSelectedPage(page)}
                  className="border-b border-slate-800/50 hover:bg-[#1e2433] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-3 max-w-xs truncate text-slate-300 text-xs font-mono">
                    {page.url.replace(/^https?:\/\/[^/]+/, "")}
                  </td>
                  <td className="px-4 py-3 font-bold" style={{ color: scoreColor(page.overallScore) }}>
                    {page.overallScore}
                  </td>
                  {(["coreIntent", "edgeCases", "retrievable", "extractable", "citable", "reusable"] as ScoreDimension[]).map((d) => (
                    <td key={d} className="px-4 py-3 text-slate-400 text-xs">
                      <ScoreChip score={page.scores[d]} />
                    </td>
                  ))}
                  <td className="px-4 py-3">
                    <span className={`grade-${page.grade} rounded px-2 py-0.5 text-xs font-bold`}>
                      {page.grade}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Page detail drawer */}
      {selectedPage && (
        <PageDetail page={selectedPage} onClose={() => setSelectedPage(null)} />
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
      className="px-4 py-3 cursor-pointer hover:text-slate-300 transition-colors select-none"
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

function StatCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub?: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#161b27] p-4">
      <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold" style={{ color: color ?? "white" }}>
        {value}
        {sub && <span className="text-sm text-slate-500 ml-1">{sub}</span>}
      </p>
    </div>
  );
}

function PageDetail({ page, onClose }: { page: PageScore; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-700 bg-[#161b27] p-6 space-y-5 max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs text-slate-500 font-mono mb-1">{page.url}</p>
            <div className="flex items-center gap-2">
              <span className={`grade-${page.grade} rounded px-2 py-0.5 text-sm font-bold`}>
                {page.grade}
              </span>
              <span className="text-white text-lg font-bold">{page.overallScore}/100</span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-xl leading-none"
          >
            ×
          </button>
        </div>

        <div className="space-y-3">
          {(Object.keys(DIMENSION_LABELS) as ScoreDimension[]).map((dim) => (
            <div key={dim}>
              <div className="flex justify-between mb-1">
                <span className="text-sm text-slate-300">{DIMENSION_LABELS[dim]}</span>
                <span className="text-sm font-mono font-bold" style={{ color: scoreColor(page.scores[dim]) }}>
                  {page.scores[dim]}/100
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-[#0f1117]">
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
          <div className="space-y-3 border-t border-slate-800 pt-4">
            <h4 className="text-sm font-semibold text-white">Recommendations</h4>
            {page.recommendations.map((rec, i) => (
              <div
                key={i}
                className="rounded-lg bg-[#0f1117] border border-slate-800 p-3 space-y-1"
              >
                <div className="flex items-center gap-2">
                  <span className={`text-xs font-semibold uppercase ${priorityColor(rec.priority)}`}>
                    {rec.priority}
                  </span>
                  <span className="text-xs text-slate-500">
                    {DIMENSION_LABELS[rec.dimension]}
                  </span>
                </div>
                <p className="text-sm text-slate-300">{rec.suggestion}</p>
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
  if (score >= 80) return "#10b981";
  if (score >= 65) return "#3b82f6";
  if (score >= 50) return "#f59e0b";
  if (score >= 35) return "#f97316";
  return "#ef4444";
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
    ? "text-red-400"
    : p === "high"
    ? "text-orange-400"
    : p === "medium"
    ? "text-amber-400"
    : "text-slate-400";
}
