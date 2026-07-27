// ─────────────────────────────────────────────────────────────
//  /projects/[id]/settings — project configuration.
//  Audit source (domain / single / URL list), competitor CRUD,
//  and the danger zone. Everything here existed before the
//  left-rail split — it just lived scattered across the hub
//  header and the top nav.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import EditAuditSourceButton from "@/components/EditAuditSourceButton";
import CompetitorManager from "@/components/CompetitorManager";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import { getLatestScores } from "@/lib/hub";

export const revalidate = 0;

export default async function ProjectSettingsPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { clientScores } = await getLatestScores(params.id);

  const sourceLabel =
    project.auditSource === "single"
      ? "Single page"
      : project.auditSource === "list"
        ? `URL list · ${project.sourceUrls?.length ?? 0} page${(project.sourceUrls?.length ?? 0) !== 1 ? "s" : ""}`
        : `Whole site · up to ${project.maxPages} pages`;

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Settings
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          {project.clientName} · <span className="font-mono">{project.websiteUrl}</span>
        </p>
      </div>

      {/* ── Audit source ── */}
      <div className="anim-fade-up stagger-1 card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
              Audit source
            </p>
            <p className="text-[13px] mt-1 leading-relaxed" style={{ color: "var(--text-2)" }}>
              How the page set is built for each run. Currently:{" "}
              <span
                className="inline-block px-2 py-0.5 rounded-md text-xs font-medium align-middle"
                style={{ background: "rgba(99,102,241,0.12)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.2)" }}
              >
                {sourceLabel}
              </span>
              {project.auditSource === "domain" && project.scopePrefix && (
                <>
                  {" "}scoped to <span className="font-mono" style={{ color: "var(--indigo)" }}>{project.scopePrefix}</span>
                </>
              )}
            </p>
          </div>
          <EditAuditSourceButton
            projectId={params.id}
            auditSource={project.auditSource}
            websiteUrl={project.websiteUrl}
            scopePrefix={project.scopePrefix}
            maxPages={project.maxPages}
            sourceUrls={project.sourceUrls}
            latestRunUrls={clientScores.map((s) => s.url)}
          />
        </div>
      </div>

      {/* ── Competitors ── */}
      <div className="anim-fade-up stagger-2 card p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
              Competitors
            </p>
            <p className="text-[13px] mt-1 leading-relaxed" style={{ color: "var(--text-2)" }}>
              {project.competitors.length > 0
                ? `${project.competitors.length} tracked: ${project.competitors.map((c) => c.name).join(", ")}. Each is crawled and scored alongside your site on every run.`
                : "None tracked yet — each competitor you add is crawled and scored alongside your site on every run."}
            </p>
          </div>
          <div className="card px-1.5 py-1">
            <CompetitorManager projectId={params.id} />
          </div>
        </div>
      </div>

      {/* ── Danger zone ── */}
      <div
        className="anim-fade-up stagger-3 card p-5"
        style={{ border: "1px solid rgba(220,38,38,0.25)" }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <p className="text-sm font-semibold" style={{ color: "#dc2626" }}>
              Danger zone
            </p>
            <p className="text-[13px] mt-1 leading-relaxed" style={{ color: "var(--text-2)" }}>
              Deleting the project removes its runs, scores, drafts, and visibility data permanently.
              You&apos;ll land back on the dashboard afterwards.
            </p>
          </div>
          <DeleteProjectButton projectId={params.id} appearance="button" />
        </div>
      </div>
    </div>
  );
}
