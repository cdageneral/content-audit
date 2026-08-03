// ─────────────────────────────────────────────────────────────
//  /projects/[id]/impact — Business Impact.
//
//  Translates visibility into business terms for an executive
//  audience, across two lanes: Google Search (verified striking-
//  distance demand × the published CTR curve) and AI assistants
//  (measured prompt-citation coverage × the client's own AI
//  referral baseline). Reads only what scans already stored —
//  this page makes ZERO new API calls.
//
//  Every number is provenance-tagged (verified / modeled /
//  benchmark / client input) and missing inputs render "—",
//  never an invented figure.
// ─────────────────────────────────────────────────────────────

import { redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getImpactPageData } from "@/lib/impact/data";
import BusinessImpactView from "@/components/BusinessImpactView";

export const revalidate = 0;

export default async function ProjectImpactPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");

  const data = await getImpactPageData(params.id);

  if (!data.google && !data.ai.measured && data.ai.promptsTotal === 0) {
    return (
      <div className="anim-fade-up card p-8 text-center">
        <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
          No visibility data to project from yet
        </p>
        <p className="text-sm mt-1 max-w-xl mx-auto" style={{ color: "var(--text-3)" }}>
          Business Impact builds on this project&rsquo;s own measurements — verified
          search demand from a scan, and AI-assistant citation checks from the
          prompt set. Run an audit first; the lanes light up as the data lands.
        </p>
      </div>
    );
  }

  return (
    <BusinessImpactView
      projectId={params.id}
      google={data.google}
      ai={data.ai}
      initialInputs={data.inputs}
    />
  );
}
