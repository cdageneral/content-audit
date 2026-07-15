"use client";

import { useState } from "react";
import type { CompetitorConfig } from "@/lib/db/projects";
import type { PageScore, ScoreDimension } from "@/lib/types";
import { DIMENSION_LABELS } from "@/lib/types";
import DimensionDrilldown from "./DimensionDrilldown";

interface Props {
  clientName: string;
  clientScores: PageScore[];
  competitors: CompetitorConfig[];
  competitorScoresMap: Record<string, PageScore[]>;
  competitorColors: string[];
  /** Enables the drill-down drawer + gap-brief API calls when provided */
  projectId?: string;
}

const DIMS: ScoreDimension[] = [
  "coreIntent","edgeCases","impliedQuestions","fanOutQueries",
  "retrievable","extractable","citable","reusable",
];

const DIM_GROUP: Record<ScoreDimension, string> = {
  coreIntent: "Content quality",
  edgeCases: "Content quality",
  impliedQuestions: "Content quality",
  fanOutQueries: "Content quality",
  retrievable: "The 4 Ables",
  extractable: "The 4 Ables",
  citable: "The 4 Ables",
  reusable: "The 4 Ables",
};

function avg(scores: PageScore[], dim: ScoreDimension | "overall"): number | null {
  if (!scores.length) return null;
  if (dim === "overall") {
    return Math.round(scores.reduce((s, p) => s + p.overallScore, 0) / scores.length);
  }
  return Math.round(scores.reduce((s, p) => s + p.scores[dim], 0) / scores.length);
}

function scoreColor(s: number) {
  if (s >= 80) return "#059669";
  if (s >= 65) return "#2563eb";
  if (s >= 50) return "#d97706";
  if (s >= 35) return "#ea580c";
  return "#dc2626";
}

export default function CompetitorMatrix({
  clientName,
  clientScores,
  competitors,
  competitorScoresMap,
  competitorColors,
  projectId,
}: Props) {
  const [active, setActive] = useState<{ dim: ScoreDimension; siteId: string } | null>(null);

  const sites = [
    { id: "client", name: clientName, color: "#6366f1", scores: clientScores },
    ...competitors.map(c => ({
      id: c.id,
      name: c.name,
      color: competitorColors[c.colorIndex],
      scores: competitorScoresMap[c.id] ?? [],
    })),
  ];

  // Pre-compute averages
  const siteAvgs = sites.map(site => ({
    ...site,
    dimAvgs: Object.fromEntries(
      DIMS.map(d => [d, avg(site.scores, d)])
    ) as Record<ScoreDimension, number | null>,
    overall: avg(site.scores, "overall"),
  }));

  let lastGroup = "";

  return (
    <div className="overflow-x-auto">
      <table className="data-table min-w-full">
        <thead>
          <tr>
            <th style={{ width: "160px" }}>Dimension</th>
            {siteAvgs.map(s => (
              <th key={s.id} style={{ textAlign: "center", minWidth: "110px" }}>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                  <span style={{
                    display: "inline-block",
                    width: 8, height: 8,
                    borderRadius: "50%",
                    background: s.color,
                    flexShrink: 0,
                  }} />
                  <span style={{ color: "var(--text-2)", fontWeight: 600 }}>{s.name}</span>
                  {s.overall != null && (
                    <span style={{ fontSize: 16, fontWeight: 700, color: scoreColor(s.overall) }}>
                      {s.overall}
                    </span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {DIMS.map(dim => {
            const group = DIM_GROUP[dim];
            const showGroup = group !== lastGroup;
            lastGroup = group;

            // Find winner
            const scores = siteAvgs.map(s => s.dimAvgs[dim]);
            const maxScore = Math.max(...scores.filter((s): s is number => s != null));
            const winnerIdx = scores.findIndex(s => s === maxScore && s != null);

            return (
              <>
                {showGroup && (
                  <tr key={`group-${group}`}>
                    <td colSpan={sites.length + 1}
                      style={{
                        padding: "6px 12px 4px",
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "var(--text-3)",
                        background: "var(--bg-2)",
                      }}>
                      {group}
                    </td>
                  </tr>
                )}
                <tr key={dim}>
                  <td style={{ color: "var(--text-2)", fontSize: 13 }}>
                    {DIMENSION_LABELS[dim]}
                  </td>
                  {siteAvgs.map((s, idx) => {
                    const score = s.dimAvgs[dim];
                    const isWinner = idx === winnerIdx && score != null;
                    const clickable = score != null;
                    const isActive = active?.dim === dim && active?.siteId === s.id;
                    return (
                      <td key={s.id}
                        className={isWinner ? "matrix-winner" : ""}
                        onClick={clickable ? () => setActive({ dim, siteId: s.id }) : undefined}
                        title={clickable ? "View the evidence behind this score" : undefined}
                        style={{
                          textAlign: "center",
                          cursor: clickable ? "pointer" : undefined,
                          boxShadow: isActive ? "inset 0 0 0 2px var(--indigo)" : undefined,
                          background: isActive ? "rgba(99,102,241,0.08)" : undefined,
                          borderRadius: isActive ? 8 : undefined,
                        }}>
                        {score != null ? (
                          <span style={{
                            fontSize: 15,
                            fontWeight: isWinner ? 700 : 500,
                            color: score != null ? scoreColor(score) : "var(--text-3)",
                          }}>
                            {score}
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-3)" }}>—</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              </>
            );
          })}

          {/* Overall row */}
          <tr style={{ borderTop: "1px solid var(--border)" }}>
            <td style={{ color: "var(--text-1)", fontWeight: 600, fontSize: 13 }}>
              Overall
            </td>
            {siteAvgs.map((s, idx) => {
              const overallScores = siteAvgs.map(x => x.overall);
              const maxOverall = Math.max(...overallScores.filter((x): x is number => x != null));
              const isWinner = s.overall === maxOverall && s.overall != null;
              return (
                <td key={s.id}
                  className={isWinner ? "matrix-winner" : ""}
                  style={{ textAlign: "center" }}>
                  {s.overall != null ? (
                    <span style={{ fontSize: 18, fontWeight: 700, color: scoreColor(s.overall) }}>
                      {s.overall}
                    </span>
                  ) : <span style={{ color: "var(--text-3)" }}>—</span>}
                </td>
              );
            })}
          </tr>
        </tbody>
      </table>

      {/* Legend note */}
      <div className="px-4 py-3 text-xs" style={{ color: "var(--text-3)", borderTop: "1px solid var(--border)" }}>
        ✦ indicates best score in that dimension · Scores are page-level averages from the latest completed audit run
        · Click any score to see the evidence behind it
      </div>

      {/* Drill-down drawer */}
      {active && (() => {
        const site = sites.find((s) => s.id === active.siteId);
        if (!site) return null;
        return (
          <DimensionDrilldown
            projectId={projectId}
            dimension={active.dim}
            group={DIM_GROUP[active.dim]}
            siteName={site.name}
            siteColor={site.color}
            siteScores={site.scores}
            competitorId={active.siteId === "client" ? null : active.siteId}
            clientName={clientName}
            clientColor="#6366f1"
            clientScores={clientScores}
            onClose={() => setActive(null)}
          />
        );
      })()}
    </div>
  );
}
