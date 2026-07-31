// ─────────────────────────────────────────────────────────────
//  /projects/[id]/visibility/rankings — Google Rankings tab.
//  Traditional organic positions surfaced from the SERP snapshots
//  the AI-visibility pipeline already stores on every scan. This
//  page makes ZERO new API calls — lib/rankings/rollup only reads
//  what's in the database. Observed positions only, one trend
//  point per scan (data-honesty rules in the rollup module).
// ─────────────────────────────────────────────────────────────

import { redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getRankRollup } from "@/lib/rankings/rollup";
import { serpConfigured } from "@/lib/serp/semrush";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import RankingsView from "@/components/RankingsView";

export const revalidate = 0;

export default async function ProjectRankingsPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");

  const rollup = await getRankRollup(params.id).catch(() => null);
  const serpEnabled = serpConfigured() || dfsConfigured();

  if (!rollup || rollup.tracked + rollup.brandedCount === 0) {
    return (
      <div className="anim-fade-up card p-8 text-center">
        <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          No ranking data yet
        </p>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          {serpEnabled
            ? "Google positions come from the same SERP snapshots as the AI Answers tab — they're stored automatically with each audit run. Start one from the Run Audit button."
            : "Search visibility isn't configured. Add a DataForSEO or Semrush key, then re-run the audit."}
        </p>
      </div>
    );
  }

  return <RankingsView projectId={params.id} rollup={rollup} />;
}
