// ─────────────────────────────────────────────────────────────
//  /projects/[id]/schedule — Scan Schedule (Setup).
//  Pick a cadence and the project re-scans itself automatically:
//  daily sweep cron → same run pipeline as the Run button → "what
//  moved" email. Server component: loads schedule + run history,
//  hands everything to the client view.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProject } from "@/lib/db/projects";
import { getScanSchedule, listScanRuns } from "@/lib/schedule/store";
import { emailConfigured } from "@/lib/schedule/email";
import ScanScheduleView from "@/components/ScanScheduleView";

export const revalidate = 0;

export default async function ScanSchedulePage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProject(params.id).catch(() => null);
  if (!project) return notFound();

  const [schedule, runs] = await Promise.all([
    getScanSchedule(params.id).catch(() => null),
    listScanRuns(params.id).catch(() => []),
  ]);

  return (
    <ScanScheduleView
      projectId={params.id}
      projectName={project.clientName}
      initialSchedule={schedule}
      initialRuns={runs}
      emailReady={emailConfigured()}
    />
  );
}
