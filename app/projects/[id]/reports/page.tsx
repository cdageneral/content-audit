// ─────────────────────────────────────────────────────────────
//  /projects/[id]/reports — client-facing deliverables.
//  The PDF assessment (latest completed run) and the optimization
//  packet bundle (one Word packet per optimized page).
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import { getLatestScores, buildOptimizedRows } from "@/lib/hub";

export const revalidate = 0;

export default async function ProjectReportsPage({
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
  const draftedCount = optimizedRows.filter((r) => r.draftCount > 0).length;

  const lastAudited = project.lastAuditedAt
    ? new Date(project.lastAuditedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })
    : null;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Reports
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          Client-ready deliverables, generated from the latest completed run
          {lastAudited ? ` (audited ${lastAudited})` : ""}.
        </p>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* ── PDF assessment ── */}
        <div className="anim-fade-up stagger-1 card p-5 flex flex-col">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            Client assessment (PDF)
          </p>
          <p className="text-[13px] mt-1.5 leading-relaxed flex-1" style={{ color: "var(--text-2)" }}>
            The full C3-branded readiness assessment: overall and per-dimension scores, the education
            section for every dimension, competitor comparison, and the priority findings — ready to
            send as-is.
          </p>
          {hasResults ? (
            <a
              href={`/api/projects/${params.id}/report`}
              className="btn-primary inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg mt-4 self-start"
              title="Download the client-ready PDF assessment from the latest completed run"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download assessment
            </a>
          ) : (
            <p className="text-xs mt-4" style={{ color: "var(--text-3)" }}>
              Available after the first completed audit run.
            </p>
          )}
        </div>

        {/* ── Optimization packet bundle ── */}
        <div className="anim-fade-up stagger-2 card p-5 flex flex-col">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            Optimization packets (Word, zipped)
          </p>
          <p className="text-[13px] mt-1.5 leading-relaxed flex-1" style={{ color: "var(--text-2)" }}>
            One implementation packet per optimized page: the rewritten copy with heading structure,
            schema markup, and metadata — everything a content team needs to ship the changes.
          </p>
          {draftedCount > 0 ? (
            <a
              href={`/api/projects/${params.id}/packets`}
              className="btn-primary inline-flex items-center gap-1.5 text-sm px-4 py-2 rounded-lg mt-4 self-start"
              title={`Download packets for all ${draftedCount} optimized page${draftedCount === 1 ? "" : "s"} as a zip`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download {draftedCount} packet{draftedCount === 1 ? "" : "s"}
            </a>
          ) : (
            <p className="text-xs mt-4" style={{ color: "var(--text-3)" }}>
              No drafted pages yet —{" "}
              <Link href={`/projects/${params.id}/optimize`} className="font-semibold hover:underline" style={{ color: "#4f46e5" }}>
                optimize a page
              </Link>{" "}
              and its packet lands here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
