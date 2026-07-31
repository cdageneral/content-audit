// ─────────────────────────────────────────────────────────────
//  /projects/[id]/visibility/combined — Combined tab.
//  Every tracked keyword placed on Google rank × AI-answer
//  citation: Owning both / Can win in AI / AI-first / Invisible.
//  Same rollup as the Rankings tab (stored snapshots, no new API
//  calls); classification is deterministic rules over observed
//  data — see lib/rankings/rollup.
// ─────────────────────────────────────────────────────────────

import { redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getRankRollup } from "@/lib/rankings/rollup";
import { serpConfigured } from "@/lib/serp/semrush";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import CombinedVisibilityView from "@/components/CombinedVisibilityView";

export const revalidate = 0;

export default async function ProjectCombinedVisibilityPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");

  const rollup = await getRankRollup(params.id).catch(() => null);
  const serpEnabled = serpConfigured() || dfsConfigured();

  if (!rollup || rollup.tracked === 0) {
    return (
      <div className="anim-fade-up card p-8 text-center">
        <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          Nothing to combine yet
        </p>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          {serpEnabled
            ? "This view needs a scan with SERP data — rankings and AI-answer status are stored automatically with each audit run."
            : "Search visibility isn't configured. Add a DataForSEO or Semrush key, then re-run the audit."}
        </p>
      </div>
    );
  }

  return <CombinedVisibilityView projectId={params.id} rollup={rollup} />;
}
