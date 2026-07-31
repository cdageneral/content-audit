// ─────────────────────────────────────────────────────────────
//  /projects/[id]/competitors — competitive comparison.
//  The dimension matrix (with ▲/▼ vs-previous-run tickers and
//  the click-through evidence drawer) plus competitor management.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import CompetitorMatrix from "@/components/CompetitorMatrix";
import CompetitorManager from "@/components/CompetitorManager";
import PublishingVelocity from "@/components/PublishingVelocity";
import { COMPETITOR_COLORS, getLatestScores } from "@/lib/hub";
import { buildVelocityData, type VelocityData } from "@/lib/velocity/rollup";
import type { DimensionScores } from "@/lib/types";

export const revalidate = 0;

export default async function ProjectCompetitorsPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { latestScoresMap, clientScores, hasResults } = await getLatestScores(params.id);

  // Publishing velocity (observed data only) — best-effort: the panel shows
  // its own "builds from your next scan" state when there's no inventory, and
  // a rollup failure must never take down the matrix above it.
  const velocity: VelocityData =
    project.competitors.length > 0
      ? await buildVelocityData(project).catch(() => ({
          entities: [],
          monthLabels: [],
          hasInventory: false,
          newPages: [],
          anyDiffReady: false,
          scopeNote: null,
        }))
      : { entities: [], monthLabels: [], hasInventory: false, newPages: [], anyDiffReady: false, scopeNote: null };

  // Previous-run averages per site (for the matrix ▲/▼ tickers) — history is
  // ordered ASC; the second-to-last point per site is "last run".
  const prevRuns: Record<string, { overall: number | null; dims: Partial<Record<keyof DimensionScores, number>> }> = {};
  {
    const siteKeys: (string | null)[] = [null, ...project.competitors.map((c) => c.id)];
    for (const key of siteKeys) {
      const pts = project.history.filter((h) => (h.competitorId ?? null) === key);
      if (pts.length < 2) continue;
      const prev = pts[pts.length - 2];
      prevRuns[key ?? "client"] = {
        overall: Math.round(Number(prev.avgScore)),
        dims: {
          coreIntent: Math.round(Number(prev.avgCoreIntent)),
          edgeCases: Math.round(Number(prev.avgEdgeCases)),
          impliedQuestions: Math.round(Number(prev.avgImpliedQuestions)),
          fanOutQueries: Math.round(Number(prev.avgFanOutQueries)),
          retrievable: Math.round(Number(prev.avgRetrievable)),
          extractable: Math.round(Number(prev.avgExtractable)),
          citable: Math.round(Number(prev.avgCitable)),
          reusable: Math.round(Number(prev.avgReusable)),
          aioReadiness: Math.round(Number(prev.avgAioReadiness ?? 0)),
          paaCoverage: Math.round(Number(prev.avgPaaCoverage ?? 0)),
        },
      };
    }
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
            Competitors
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Latest scores side-by-side, dimension by dimension. Click a competitor&apos;s cell for the
            evidence behind their edge.
          </p>
        </div>
        {/* CompetitorManager renders its own "Competitors" button + modal */}
        <div className="card px-1.5 py-1">
          <CompetitorManager projectId={params.id} />
        </div>
      </div>

      {project.competitors.length === 0 ? (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            No competitors tracked yet
          </p>
          <p className="text-sm mt-1 max-w-xl mx-auto" style={{ color: "var(--text-3)" }}>
            Add the sites you&apos;re losing AI answers to — each competitor is crawled and scored on the
            same ten dimensions with every audit run, so the comparison is always apples-to-apples.
          </p>
        </div>
      ) : !hasResults ? (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            Competitors are set up — no scored run yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Run an audit from the Overview and the comparison matrix will appear here.
          </p>
        </div>
      ) : (
        <div className="anim-fade-up stagger-1 card overflow-hidden">
          <div className="p-5 border-b" style={{ borderColor: "var(--border)" }}>
            <p className="section-label mb-0">Competitive comparison — latest scores</p>
          </div>
          <CompetitorMatrix
            clientName={project.clientName}
            clientScores={clientScores}
            competitors={project.competitors}
            competitorScoresMap={latestScoresMap}
            competitorColors={COMPETITOR_COLORS}
            projectId={params.id}
            prevRuns={prevRuns}
          />
        </div>
      )}

      {/* Publishing velocity — new additive panel; the matrix above is untouched. */}
      {project.competitors.length > 0 && <PublishingVelocity data={velocity} />}
    </div>
  );
}
