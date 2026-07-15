"use client";

// ─────────────────────────────────────────────────────────────
//  DimensionDrilldown — slide-in drawer opened from a
//  CompetitorMatrix cell. Shows the stored evidence behind one
//  site's score on one dimension (rationales, evidence quotes,
//  recommendations — all real data from the latest audit run),
//  plus an on-demand, cached "Explain the gap" Claude brief.
// ─────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PageScore, ScoreDimension } from "@/lib/types";
import { DIMENSION_LABELS } from "@/lib/types";

interface Props {
  projectId?: string;
  dimension: ScoreDimension;
  group: string;
  /** Site whose cell was clicked */
  siteName: string;
  siteColor: string;
  siteScores: PageScore[];
  /** null when the clicked site IS the client */
  competitorId: string | null;
  clientName: string;
  clientColor: string;
  clientScores: PageScore[];
  onClose: () => void;
}

type BriefState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "done"; brief: string; cached: boolean; modelVersion: string }
  | { status: "error"; message: string };

function scoreColor(s: number) {
  if (s >= 80) return "#059669";
  if (s >= 65) return "#2563eb";
  if (s >= 50) return "#d97706";
  if (s >= 35) return "#ea580c";
  return "#dc2626";
}

function avgDim(scores: PageScore[], dim: ScoreDimension): number | null {
  if (!scores.length) return null;
  return Math.round(scores.reduce((s, p) => s + p.scores[dim], 0) / scores.length);
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "") + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

const PRIORITY_STYLE: Record<string, { bg: string; fg: string }> = {
  critical: { bg: "rgba(220,38,38,0.12)", fg: "#dc2626" },
  high: { bg: "rgba(234,88,12,0.12)", fg: "#ea580c" },
  medium: { bg: "rgba(217,119,6,0.12)", fg: "#d97706" },
  low: { bg: "rgba(37,99,235,0.10)", fg: "#2563eb" },
};
const PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export default function DimensionDrilldown({
  projectId,
  dimension,
  group,
  siteName,
  siteColor,
  siteScores,
  competitorId,
  clientName,
  clientColor,
  clientScores,
  onClose,
}: Props) {
  const isClient = competitorId === null;
  const [tab, setTab] = useState<"evidence" | "gap">("evidence");
  const [brief, setBrief] = useState<BriefState>({ status: "idle" });
  // Staleness guard: identifies which cell an in-flight fetch belongs to, so a
  // response landing after the drawer was retargeted can't display the wrong
  // competitor's brief.
  const briefKey = `${dimension}|${competitorId ?? "client"}`;
  const briefKeyRef = useRef(briefKey);
  briefKeyRef.current = briefKey;

  // Reset when retargeted to a different cell
  useEffect(() => {
    setTab("evidence");
    setBrief({ status: "idle" });
  }, [dimension, competitorId]);

  // Close on Escape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const themAvg = avgDim(siteScores, dimension);
  const youAvg = avgDim(clientScores, dimension);
  const gap = themAvg != null && youAvg != null ? themAvg - youAvg : null;

  // Exclude zero-filled "Scoring failed" placeholder rows — they carry no
  // real evidence and would otherwise always occupy the "weakest" slots.
  const realSite = siteScores.filter((p) => p.modelVersion !== "error");
  const realClient = clientScores.filter((p) => p.modelVersion !== "error");
  const siteSorted = [...realSite].sort((a, b) => b.scores[dimension] - a.scores[dimension]);
  const clientSorted = [...realClient].sort((a, b) => a.scores[dimension] - b.scores[dimension]);
  const topPages = siteSorted.slice(0, 3);
  const weakPages = (isClient ? [...clientSorted] : clientSorted).slice(0, 3);

  // Range + "beat your median" stats (real page-level data)
  const siteVals = siteScores.map((p) => p.scores[dimension]);
  const clientVals = clientScores.map((p) => p.scores[dimension]);
  const clientMedian = clientVals.length ? median(clientVals) : null;
  const beatMedian =
    clientMedian != null ? siteVals.filter((v) => v > clientMedian).length : null;

  // Client recommendations for this dimension, deduped, highest priority first
  const seen = new Set<string>();
  const recs = clientScores
    .flatMap((p) => p.recommendations ?? [])
    .filter((r) => r.dimension === dimension)
    .filter((r) => {
      const k = r.suggestion.trim().toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9))
    .slice(0, 4);

  async function loadBrief() {
    if (!projectId || !competitorId) return;
    const requestKey = briefKey;
    setBrief({ status: "loading" });
    try {
      const res = await fetch(`/api/projects/${projectId}/gap-brief`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ competitorId, dimension }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.brief) {
        throw new Error(data?.error ?? `Request failed (${res.status})`);
      }
      if (requestKey !== briefKeyRef.current) return; // drawer was retargeted
      setBrief({
        status: "done",
        brief: data.brief,
        cached: !!data.cached,
        modelVersion: data.modelVersion ?? "",
      });
    } catch (err) {
      if (requestKey !== briefKeyRef.current) return;
      setBrief({
        status: "error",
        message: err instanceof Error ? err.message : "Failed to generate brief",
      });
    }
  }

  const pageCard = (p: PageScore, accent: string) => {
    const quotes = p.evidence?.[dimension] ?? [];
    return (
      <div
        key={p.id}
        className="rounded-lg p-3 mb-2"
        style={{ border: "1px solid var(--border)", background: "var(--bg-1)" }}
      >
        <div className="flex items-baseline justify-between gap-2 mb-1">
          <a
            href={p.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-semibold truncate hover:underline"
            style={{ color: "var(--indigo-dim)" }}
            title={p.url}
          >
            {pathOf(p.url)}
          </a>
          <span className="text-sm font-bold flex-shrink-0" style={{ color: scoreColor(p.scores[dimension]) }}>
            {p.scores[dimension]}
          </span>
        </div>
        {p.rationale?.[dimension] && (
          <p className="text-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
            <span style={{ color: "var(--text-1)", fontWeight: 600 }}>Scorer&apos;s rationale: </span>
            {p.rationale[dimension]}
          </p>
        )}
        {quotes.map((q, i) => (
          <div
            key={i}
            className="mt-1.5 text-xs italic rounded-r-lg px-2.5 py-1.5"
            style={{
              color: "var(--text-2)",
              background: "var(--bg-2)",
              borderLeft: `3px solid ${accent}`,
            }}
          >
            &ldquo;{q}&rdquo;
          </div>
        ))}
      </div>
    );
  };

  // Portal to <body>: the matrix card's entrance animation leaves a persistent
  // transform on an ancestor (anim-fade-up, fill-mode both), which would turn
  // that ancestor into the containing block for position:fixed and clip the
  // drawer inside the card. Rendering at the body level sidesteps that.
  if (typeof document === "undefined") return null;

  return createPortal(
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 anim-fade-in"
        style={{ background: "rgba(15,23,42,0.25)" }}
        onClick={onClose}
      />
      {/* Drawer */}
      <div
        className="fixed top-0 right-0 bottom-0 z-50 overflow-y-auto anim-slide-r"
        style={{
          width: "min(440px, 100vw)",
          background: "var(--bg-1)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-12px 0 40px rgba(15,23,42,0.10)",
        }}
      >
        {/* Header */}
        <div
          className="sticky top-0 p-5 pb-4 z-10"
          style={{ background: "var(--bg-1)", borderBottom: "1px solid var(--border)" }}
        >
          <button
            onClick={onClose}
            className="absolute top-4 right-4 w-7 h-7 rounded-lg text-sm"
            style={{ background: "var(--bg-2)", color: "var(--text-2)" }}
            aria-label="Close"
          >
            ✕
          </button>
          <div
            className="text-[10px] font-bold uppercase"
            style={{ color: "var(--indigo)", letterSpacing: "0.08em" }}
          >
            {DIMENSION_LABELS[dimension]} · {group}
          </div>
          <h2 className="text-lg font-bold mt-0.5 mb-3" style={{ color: "var(--text-1)" }}>
            {isClient
              ? `${clientName} — behind your ${themAvg ?? "—"}`
              : `Why ${siteName} scores ${themAvg ?? "—"}`}
          </h2>

          {!isClient && (
            <div className="flex items-center gap-3">
              <div className="flex-1 rounded-lg px-3 py-2" style={{ background: "var(--bg-2)" }}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-3)" }}>
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: siteColor }} />
                  {siteName}
                </div>
                <div className="text-xl font-bold" style={{ color: themAvg != null ? scoreColor(themAvg) : "var(--text-3)" }}>
                  {themAvg ?? "—"}
                </div>
              </div>
              {gap != null && (
                <span
                  className="text-[11px] font-bold px-2.5 py-1 rounded-full whitespace-nowrap"
                  style={
                    gap >= 0
                      ? { background: "rgba(220,38,38,0.10)", color: "var(--red)" }
                      : { background: "rgba(5,150,105,0.10)", color: "var(--green)" }
                  }
                >
                  {gap >= 0 ? `−${gap} vs you` : `+${-gap} vs you`}
                </span>
              )}
              <div className="flex-1 rounded-lg px-3 py-2" style={{ background: "var(--bg-2)" }}>
                <div className="flex items-center gap-1.5 text-[11px] font-semibold" style={{ color: "var(--text-3)" }}>
                  <span className="w-2 h-2 rounded-full inline-block" style={{ background: clientColor }} />
                  {clientName}
                </div>
                <div className="text-xl font-bold" style={{ color: youAvg != null ? scoreColor(youAvg) : "var(--text-3)" }}>
                  {youAvg ?? "—"}
                </div>
              </div>
            </div>
          )}

          {!isClient && projectId && (
            <div className="flex gap-1.5 mt-3">
              <button
                onClick={() => setTab("evidence")}
                className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
                style={
                  tab === "evidence"
                    ? { background: "var(--indigo)", color: "#fff" }
                    : { background: "var(--bg-1)", color: "var(--text-2)", border: "1px solid var(--border)" }
                }
              >
                Evidence
              </button>
              <button
                onClick={() => {
                  setTab("gap");
                  if (brief.status === "idle") loadBrief();
                }}
                className="flex-1 py-1.5 rounded-lg text-xs font-semibold"
                style={
                  tab === "gap"
                    ? { background: "var(--indigo)", color: "#fff" }
                    : { background: "var(--bg-1)", color: "var(--text-2)", border: "1px solid var(--border)" }
                }
              >
                ✦ Explain the gap
              </button>
            </div>
          )}
        </div>

        {tab === "evidence" && (
          <div>
            {/* Distribution */}
            <div className="p-5 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
              <p className="text-[11px] font-bold uppercase mb-2.5" style={{ color: "var(--text-3)", letterSpacing: "0.07em" }}>
                Page score distribution
              </p>
              {[{ name: siteName, color: siteColor, val: themAvg }, ...(!isClient ? [{ name: clientName, color: clientColor, val: youAvg }] : [])].map((row) => (
                <div key={row.name} className="flex items-center gap-2 mb-2 text-[11px]">
                  <span className="w-24 truncate font-semibold" style={{ color: "var(--text-2)" }}>{row.name}</span>
                  <div className="flex-1 h-2 rounded-full overflow-hidden" style={{ background: "var(--bg-2)" }}>
                    <div className="h-full rounded-full" style={{ width: `${row.val ?? 0}%`, background: row.color }} />
                  </div>
                  <span className="w-7 text-right font-bold" style={{ color: row.val != null ? scoreColor(row.val) : "var(--text-3)" }}>
                    {row.val ?? "—"}
                  </span>
                </div>
              ))}
              {siteVals.length > 0 && (
                <p className="text-[11px] mt-1.5" style={{ color: "var(--text-3)" }}>
                  {isClient
                    ? `Your ${siteVals.length} pages range ${Math.min(...siteVals)}–${Math.max(...siteVals)} on this dimension`
                    : `Their pages range ${Math.min(...siteVals)}–${Math.max(...siteVals)}` +
                      (clientVals.length ? ` · yours range ${Math.min(...clientVals)}–${Math.max(...clientVals)}` : "") +
                      (beatMedian != null ? ` · ${beatMedian} of their ${siteVals.length} pages beat your median` : "")}
                </p>
              )}
            </div>

            {/* Their top pages */}
            <div className="p-5 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
              <p className="text-[11px] font-bold uppercase mb-2.5" style={{ color: "var(--text-3)", letterSpacing: "0.07em" }}>
                {isClient ? "🏆 Your strongest pages" : `🏆 What ${siteName}'s top pages are doing`}
              </p>
              {topPages.length ? topPages.map((p) => pageCard(p, siteColor)) : (
                <p className="text-xs" style={{ color: "var(--text-3)" }}>No scored pages yet.</p>
              )}
            </div>

            {/* Your weakest pages */}
            <div className="p-5 pb-4" style={{ borderBottom: "1px solid var(--border)" }}>
              <p className="text-[11px] font-bold uppercase mb-2.5" style={{ color: "var(--text-3)", letterSpacing: "0.07em" }}>
                📉 Where your pages lose the points
              </p>
              {weakPages.length ? weakPages.map((p) => pageCard(p, clientColor)) : (
                <p className="text-xs" style={{ color: "var(--text-3)" }}>No scored pages yet.</p>
              )}
            </div>

            {/* Recommendations */}
            <div className="p-5 pb-8">
              <p className="text-[11px] font-bold uppercase mb-2.5" style={{ color: "var(--text-3)", letterSpacing: "0.07em" }}>
                🔧 Stored recommendations for this dimension
              </p>
              {recs.length ? (
                recs.map((r, i) => {
                  const st = PRIORITY_STYLE[r.priority] ?? PRIORITY_STYLE.low;
                  return (
                    <div key={i} className="flex gap-2.5 mb-2.5 text-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
                      <span
                        className="flex-shrink-0 text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-md h-fit mt-0.5"
                        style={{ background: st.bg, color: st.fg, letterSpacing: "0.04em" }}
                      >
                        {r.priority}
                      </span>
                      <span>{r.suggestion}</span>
                    </div>
                  );
                })
              ) : (
                <p className="text-xs" style={{ color: "var(--text-3)" }}>
                  No stored recommendations target this dimension — it isn&apos;t among your weakest.
                </p>
              )}
              <p className="text-[10.5px] mt-4 leading-relaxed" style={{ color: "var(--text-3)" }}>
                Rationales and quotes above are the scoring model&apos;s stored assessment of each
                crawled page from the latest completed run — click any page to verify on the live URL.
              </p>
            </div>
          </div>
        )}

        {tab === "gap" && (
          <div className="p-5 pb-8">
            {brief.status === "loading" && (
              <div className="text-center py-8">
                <div
                  className="inline-block w-6 h-6 rounded-full border-2 animate-spin"
                  style={{ borderColor: "var(--bg-3)", borderTopColor: "var(--indigo)" }}
                />
                <p className="text-xs mt-3" style={{ color: "var(--text-3)" }}>
                  Comparing both sites&apos; stored evidence…
                </p>
              </div>
            )}
            {brief.status === "error" && (
              <div>
                <p className="text-xs mb-3" style={{ color: "var(--red)" }}>{brief.message}</p>
                <button
                  onClick={loadBrief}
                  className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                  style={{ background: "var(--indigo)", color: "#fff" }}
                >
                  Retry
                </button>
              </div>
            )}
            {brief.status === "done" && (
              <div>
                <p className="text-[10.5px] mb-3" style={{ color: "var(--text-3)" }}>
                  {brief.cached ? "Cached analysis for this run pair" : "Freshly generated"} ·
                  model {brief.modelVersion || "n/a"} · derived from the stored crawl data —
                  verify counts against the Evidence tab
                </p>
                <div
                  className="text-[12.5px] leading-relaxed whitespace-pre-wrap"
                  style={{ color: "var(--text-2)" }}
                >
                  {brief.brief}
                </div>
              </div>
            )}
            {brief.status === "idle" && (
              <button
                onClick={loadBrief}
                className="w-full py-2.5 rounded-lg text-sm font-semibold"
                style={{ background: "linear-gradient(135deg, var(--indigo), var(--purple))", color: "#fff" }}
              >
                ✦ Explain this gap
              </button>
            )}
          </div>
        )}
      </div>
    </>,
    document.body
  );
}
