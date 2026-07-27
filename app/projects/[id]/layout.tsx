// ─────────────────────────────────────────────────────────────
//  /projects/[id]/layout.tsx — the project app shell.
//  Wraps every project section (Overview, Pages, AI Visibility,
//  Competitors, Optimize + workbench, Reports, Settings) in the
//  left rail. Access-gates the whole subtree and runs the
//  self-heal sweep once per server render so a deep link into
//  any section still reconciles stuck jobs.
//
//  NOTE (App Router): this layout does NOT re-render on soft
//  navigation between sibling sections, so the rail badges can
//  lag until the next full load. That's acceptable — they're
//  orientation, not live telemetry.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getRailStats, runSelfHeal } from "@/lib/hub";
import ProjectRail from "@/components/ProjectRail";

export const revalidate = 0;

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { id: string };
}) {
  // Same gate the old hub page ran (each section still re-checks; this stops
  // anyone outside the project's company from even seeing the shell).
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");

  const stats = await getRailStats(params.id);
  if (!stats.exists) return notFound();

  // Self-heal stuck jobs on every hard load of any project section — the old
  // hub ran this only on the hub page, which meant a user living in the
  // workbench never triggered reconciliation.
  await runSelfHeal(params.id).catch(() => null);

  return (
    <div className="lg:flex items-start">
      <ProjectRail
        projectId={params.id}
        name={stats.clientName}
        domain={stats.websiteUrl}
        pageCount={stats.pageCount}
        needsWork={stats.needsWork}
        competitorCount={stats.competitorCount}
      />
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}
