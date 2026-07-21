"use client";

// ─────────────────────────────────────────────────────────────
//  Optimized-pages summary: one place to see every page that has
//  been worked on in the Optimize workbench — baseline → projected
//  score, projected lift, verification state — plus per-page and
//  bulk packet export.
//
//  Everything here is PROJECTED (what-if). It is deliberately kept
//  visually distinct from the measured audit results and never
//  feeds averages, trends, or competitor comparisons.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import InfoTip from "@/components/InfoTip";

export interface OptimizedRow {
  url: string;
  pageId: string;
  baseline: number;
  simulated: number | null;
  grade: string | null;
  version: number;
  draftCount: number;
  draftId: string;
  simulationId: string | null;
  verified: boolean;
  verifiedMatched: boolean | null;
}

export default function OptimizedSummary({
  projectId,
  rows,
}: {
  projectId: string;
  rows: OptimizedRow[];
}) {
  const [zipping, setZipping] = useState(false);

  const simulatedRows = rows.filter((r) => r.simulated != null);
  const lifts = simulatedRows.map((r) => r.simulated! - r.baseline);
  const totalLift = lifts.reduce((a, b) => a + b, 0);
  const avgBaseline = simulatedRows.length
    ? Math.round(simulatedRows.reduce((a, r) => a + r.baseline, 0) / simulatedRows.length)
    : null;
  const avgProjected = simulatedRows.length
    ? Math.round(simulatedRows.reduce((a, r) => a + r.simulated!, 0) / simulatedRows.length)
    : null;

  // The bundle download can take a few seconds (a docx per page). Use a hidden
  // navigation so the button can show a spinner instead of the tab freezing.
  async function exportAll() {
    if (zipping) return;
    setZipping(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/packets`);
      if (!res.ok) {
        const msg = await res.json().catch(() => ({}));
        alert(msg?.error || `Export failed (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const cd = res.headers.get("Content-Disposition") || "";
      const m = /filename="([^"]+)"/.exec(cd);
      const name = m?.[1] || "optimization-packets.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      alert("Export failed — please try again.");
    } finally {
      setZipping(false);
    }
  }

  return (
    <div className="rounded-xl border border-indigo-200 bg-white overflow-hidden">
      <div className="p-4 border-b border-slate-200 flex items-center gap-3 flex-wrap bg-indigo-50/50">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5 flex-1 min-w-[200px]">
          Optimized Pages — Projected Impact
          <InfoTip
            title="Optimized Pages"
            text="Every page you've worked on in the Optimize workbench, with its saved draft's simulated score versus the current live score. These are projected (what-if) results — they never change your real audit scores, averages, or competitor comparisons until you publish and re-run the audit."
          />
        </h3>
        <button
          onClick={exportAll}
          disabled={zipping}
          title="Download an implementation packet (.docx) for every optimized page, zipped"
          className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 transition-colors disabled:opacity-60"
        >
          {zipping ? (
            <>
              <span className="inline-block w-3 h-3 rounded-full border-2 border-white/70 border-t-transparent animate-spin" />
              Building…
            </>
          ) : (
            <>⬇ Export all packets</>
          )}
        </button>
      </div>

      {/* Rollup stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-slate-100 border-b border-slate-200">
        <Stat label="Pages optimized" value={String(rows.length)} />
        <Stat
          label="Simulated"
          value={simulatedRows.length ? String(simulatedRows.length) : "0"}
          sub={rows.length > simulatedRows.length ? `${rows.length - simulatedRows.length} draft-only` : undefined}
        />
        <Stat
          label="Avg projected"
          value={avgProjected != null ? `${avgBaseline} → ${avgProjected}` : "—"}
          valueColor={avgProjected != null ? scoreColor(avgProjected) : undefined}
        />
        <Stat
          label="Total projected lift"
          value={simulatedRows.length ? `${totalLift >= 0 ? "+" : ""}${totalLift} pts` : "—"}
          valueColor={totalLift > 0 ? "#059669" : totalLift < 0 ? "#dc2626" : undefined}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
              <th className="text-left px-4 py-2.5">Page</th>
              <th className="text-left px-4 py-2.5">Current</th>
              <th className="text-left px-4 py-2.5">Projected</th>
              <th className="text-left px-4 py-2.5">Δ</th>
              <th className="text-left px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = r.simulated != null ? r.simulated - r.baseline : null;
              return (
                <tr key={r.url} className="border-b border-slate-200/70 hover:bg-slate-50 transition-colors">
                  <td className="px-4 py-2.5 max-w-xs truncate text-slate-700 text-xs font-mono" title={r.url}>
                    {r.url.replace(/^https?:\/\/[^/]+/, "") || r.url}
                  </td>
                  <td className="px-4 py-2.5 font-bold" style={{ color: scoreColor(r.baseline) }}>
                    {r.baseline}
                  </td>
                  <td className="px-4 py-2.5">
                    {r.simulated != null ? (
                      <span className="inline-flex items-center gap-1.5">
                        <span className="font-bold" style={{ color: scoreColor(r.simulated) }}>
                          {r.simulated}
                        </span>
                        {r.grade && (
                          <span className={`grade-${r.grade} rounded px-1.5 py-0.5 text-[10px] font-bold`}>
                            {r.grade}
                          </span>
                        )}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-400">not simulated</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 font-semibold text-xs">
                    {d != null ? (
                      <span style={{ color: d > 0 ? "#059669" : d < 0 ? "#dc2626" : "#64748b" }}>
                        {d > 0 ? `▲ +${d}` : d < 0 ? `▼ ${d}` : "±0"}
                      </span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-xs">
                    {r.verified && r.verifiedMatched === true ? (
                      <span className="font-semibold" style={{ color: "#059669" }}>✓ Verified</span>
                    ) : r.verified && r.verifiedMatched === false ? (
                      <span className="font-semibold" style={{ color: "#d97706" }}>⚠ Mismatch</span>
                    ) : (
                      <span className="text-slate-500">
                        Draft v{r.version}
                        {r.draftCount > 1 ? ` · ${r.draftCount}` : ""}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-2 whitespace-nowrap">
                      <a
                        href={`/projects/${projectId}/optimize/${r.pageId}`}
                        className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                      >
                        Review
                      </a>
                      <a
                        href={`/api/optimize/${r.pageId}/export?draftId=${r.draftId}${
                          r.simulationId ? `&simulationId=${r.simulationId}` : ""
                        }`}
                        title="Download this page's implementation packet (.docx)"
                        className="rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        ⬇ Packet
                      </a>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="px-4 py-2.5 text-[11px] text-slate-400 border-t border-slate-100">
        Projected scores are deterministic simulations of your saved drafts. They do not affect your
        audit history — publish a page and re-run the audit to confirm the real score.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  sub,
  valueColor,
}: {
  label: string;
  value: string;
  sub?: string;
  valueColor?: string;
}) {
  return (
    <div className="px-4 py-3">
      <p className="text-[11px] text-slate-500 uppercase tracking-wide mb-0.5">{label}</p>
      <p className="text-lg font-bold" style={{ color: valueColor ?? "#0f172a" }}>
        {value}
      </p>
      {sub && <p className="text-[11px] text-slate-400 mt-0.5">{sub}</p>}
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
