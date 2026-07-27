// ─────────────────────────────────────────────────────────────
//  /projects/[id]/pages — every audited page, full width.
//  The AuditResults table (sticky URL left / action right — see
//  the wide-table rules in AuditResults.tsx) finally gets the
//  whole viewport instead of fighting five sibling cards.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import AuditResults from "@/components/AuditResults";
import { getLatestSerpJobId, getSerpPageSummaries } from "@/lib/db/serp";
import {
  COMPETITOR_COLORS,
  computeQuickSummary,
  getLatestScores,
} from "@/lib/hub";
import Link from "next/link";

export const revalidate = 0;

export default async function ProjectPagesPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { latestScoresMap, clientScores, clientJobId, hasResults } = await getLatestScores(params.id);
  const optimizeStates = hasResults ? await getProjectOptimizeStates(params.id) : {};

  let serpSummaries: Awaited<ReturnType<typeof getSerpPageSummaries>> | undefined;
  const serpJobId = await getLatestSerpJobId(params.id).catch(() => null);
  if (serpJobId) {
    serpSummaries = await getSerpPageSummaries(serpJobId).catch(() => undefined);
  }

  const competitorPageEntries = project.competitors.flatMap((c) => {
    const cs = latestScoresMap[c.id] ?? [];
    return cs.map((p) => ({
      competitorName: c.name,
      color: COMPETITOR_COLORS[c.colorIndex],
      url: p.url,
      score: p.overallScore,
      grade: p.grade,
    }));
  });

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Pages
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          Every audited page, scored across ten dimensions. Click a row for the full drilldown; the
          Optimize action opens that page&apos;s workbench.
        </p>
      </div>

      {hasResults ? (
        <div className="anim-fade-up stagger-1">
          <AuditResults
            serpSummaries={serpSummaries}
            job={{ id: clientJobId } as any}
            scores={clientScores}
            summary={computeQuickSummary(clientScores)}
            competitorPages={competitorPageEntries}
            projectId={params.id}
            auditSource={project.auditSource}
            sourceUrls={project.sourceUrls}
            optimizeStates={optimizeStates}
          />
        </div>
      ) : (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            No audit results yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Run your first audit from the{" "}
            <Link href={`/projects/${params.id}`} className="font-semibold hover:underline" style={{ color: "#4f46e5" }}>
              Overview
            </Link>{" "}
            — every crawled page will land here with its scores.
          </p>
        </div>
      )}
    </div>
  );
}
