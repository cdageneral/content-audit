// ─────────────────────────────────────────────────────────────
//  /projects/[id]/optimize — the optimization queue.
//  Two lists: pages already being optimized (OptimizedSummary —
//  projected impact, drafts, verification), and the work queue
//  of pages that still need attention, weakest first. Each row
//  deep-links into that page's workbench (/optimize/[pageId]).
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import OptimizedSummary from "@/components/OptimizedSummary";
import { getLatestScores, buildOptimizedRows, gradeColor } from "@/lib/hub";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";

export const revalidate = 0;

export default async function ProjectOptimizePage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { clientScores, hasResults } = await getLatestScores(params.id);
  const optimizeStates = hasResults ? await getProjectOptimizeStates(params.id) : {};
  const optimizedRows = buildOptimizedRows(clientScores, optimizeStates);

  // Work queue: pages with no optimization work yet, weakest first.
  const queue = clientScores
    .filter((s) => !optimizeStates[s.url])
    .sort((a, b) => a.overallScore - b.overallScore);

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Optimize
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          Rewrite, simulate, and re-score pages in the workbench. Simulated scores are engine
          alignment checks — never predicted rankings or citations.
        </p>
      </div>

      {!hasResults ? (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            Nothing to optimize yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Run your first audit from the{" "}
            <Link href={`/projects/${params.id}`} className="font-semibold hover:underline" style={{ color: "#4f46e5" }}>
              Overview
            </Link>{" "}
            — scored pages queue up here, weakest first.
          </p>
        </div>
      ) : (
        <>
          {optimizedRows.length > 0 && (
            <div className="anim-fade-up stagger-1">
              <p className="section-label">Optimization progress — projected impact</p>
              <OptimizedSummary projectId={params.id} rows={optimizedRows} />
            </div>
          )}

          <div className="anim-fade-up stagger-2 card overflow-hidden">
            <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
              <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                Work queue{queue.length > 0 ? ` — ${queue.length} page${queue.length === 1 ? "" : "s"}` : ""}
              </p>
              <p className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>
                Weakest first. Each page&apos;s two lowest dimension scores are shown — that&apos;s where the
                workbench will focus.
              </p>
            </div>
            {queue.length === 0 ? (
              <p className="px-5 py-6 text-sm" style={{ color: "var(--text-3)" }}>
                Every audited page has optimization work in progress — nice. Check the progress list
                above, or re-run the audit to refresh baselines.
              </p>
            ) : (
              queue.map((s) => {
                const weakest = ALL_DIMENSIONS
                  .map((d) => ({ label: DIMENSION_LABELS[d], score: s.scores[d] }))
                  .sort((a, b) => a.score - b.score)
                  .slice(0, 2);
                return (
                  <div
                    key={s.pageId}
                    className="flex items-center gap-4 px-5 py-3"
                    style={{ borderTop: "1px solid var(--border)" }}
                  >
                    <span
                      className="inline-flex items-center justify-center text-[11px] font-bold rounded px-2 py-0.5 flex-shrink-0"
                      style={{
                        background: `${gradeColor(s.grade)}1f`,
                        color: gradeColor(s.grade),
                        border: `1px solid ${gradeColor(s.grade)}40`,
                      }}
                    >
                      {s.grade} · {s.overallScore}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-medium truncate" style={{ color: "var(--text-1)" }} title={s.url}>
                        {pathOf(s.url)}
                      </p>
                      <p className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>
                        {weakest.map((w) => `${w.label} ${w.score}`).join(" · ")}
                      </p>
                    </div>
                    <Link
                      href={`/projects/${params.id}/optimize/${s.pageId}`}
                      className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg hover:underline"
                      style={{ color: "#4f46e5" }}
                    >
                      Open workbench →
                    </Link>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}
