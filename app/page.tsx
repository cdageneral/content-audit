import Link from "next/link";
import { listProjects } from "@/lib/db/projects";
import type { Project } from "@/lib/db/projects";
import DeleteProjectButton from "@/components/DeleteProjectButton";
import { authEnforced, seesAllProjects } from "@/lib/auth/config";
import { getActiveUser } from "@/lib/auth/session";
import { getGrantedProjectIds, getCompanyProjectIds, ensureAuthTables } from "@/lib/auth/store";

export const revalidate = 0;

export default async function DashboardPage() {
  let projects: Project[] = [];
  try {
    projects = await listProjects();
    // Company-scoped visibility (no-op unless AUTH_ENFORCED).
    if (authEnforced()) {
      const user = await getActiveUser();
      if (!user) {
        projects = [];
      } else if (!seesAllProjects(user.role)) {
        await ensureAuthTables();
        const companyIds = new Set(user.cid ? await getCompanyProjectIds(user.cid) : []);
        let allowed = projects.filter((p) => companyIds.has(p.id));
        if (user.role === "client_user") {
          const grants = await getGrantedProjectIds(user.sub);
          if (grants.length) {
            const g = new Set(grants);
            allowed = allowed.filter((p) => g.has(p.id));
          }
        }
        projects = allowed;
      }
    }
  } catch {
    // DB not yet configured
  }

  return (
    <div className="min-h-screen" style={{ background: "var(--bg-0)" }}>
      {/* Hero */}
      <div className="px-6 pt-16 pb-10 max-w-6xl mx-auto">
        <div className="anim-fade-up text-center mb-12">
          <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium mb-6"
            style={{ background: "rgba(99,102,241,0.12)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.2)" }}>
            <span className="status-dot status-running" />
            Powered by Claude Sonnet
          </div>
          <h1 className="text-5xl font-bold mb-4" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
            LLM Content<br />
            <span style={{ background: "linear-gradient(135deg, #6366f1, #7c3aed)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>
              Readiness Auditor
            </span>
          </h1>
          <p className="text-lg max-w-xl mx-auto" style={{ color: "var(--text-2)" }}>
            Track how well your content — and your competitors' — performs when retrieved, cited, and reused by AI systems.
          </p>
          <div className="mt-8">
            <Link href="/projects/new"
              className="btn-primary inline-flex items-center gap-2 px-6 py-3 text-base">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Project
            </Link>
          </div>
        </div>

        {/* Stats row */}
        {projects.length > 0 && (
          <div className="grid grid-cols-3 gap-4 mb-10 anim-fade-up stagger-1 max-w-lg mx-auto">
            <StatPill label="Projects" value={projects.length.toString()} />
            <StatPill
              label="Avg Score"
              value={String(
                Math.round(
                  projects.filter(p => p.latestScore != null).reduce((s, p) => s + (p.latestScore ?? 0), 0) /
                  Math.max(1, projects.filter(p => p.latestScore != null).length)
                )
              )}
              suffix="/100"
            />
            <StatPill
              label="Total Runs"
              value={String(projects.reduce((s, p) => s + p.runCount, 0))}
            />
          </div>
        )}

        {/* Project grid */}
        {projects.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {projects.map((p, i) => (
              <ProjectCard key={p.id} project={p} delay={i} />
            ))}
            <NewProjectCard />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────

function StatPill({ label, value, suffix }: { label: string; value: string; suffix?: string }) {
  return (
    <div className="text-center p-4 rounded-xl" style={{ background: "var(--bg-1)", border: "1px solid var(--border)" }}>
      <div className="text-2xl font-bold" style={{ color: "var(--text-1)" }}>
        {value}<span className="text-sm font-normal" style={{ color: "var(--text-3)" }}>{suffix}</span>
      </div>
      <div className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>{label}</div>
    </div>
  );
}

function ProjectCard({ project: p, delay }: { project: Project; delay: number }) {
  const grade = p.latestGrade ?? "—";
  const score = p.latestScore;
  const delta = p.scoreDelta;
  const hasScore = score != null;

  return (
    <div className={`relative group anim-fade-up stagger-${Math.min(delay + 1, 6)}`}>
      <Link href={`/projects/${p.id}`}
        className="card card-interactive block overflow-hidden">
        {/* Accent bar */}
        <div className={`accent-bar ${hasScore ? `accent-${grade}` : ""}`}
          style={!hasScore ? { background: "var(--bg-3)" } : undefined} />

        <div className="p-5">
          {/* Header */}
          <div className="flex items-start justify-between mb-4">
            <div className="flex-1 min-w-0">
              <h3 className="font-semibold text-base truncate mb-0.5" style={{ color: "var(--text-1)" }}>
                {p.clientName}
              </h3>
              <p className="text-xs truncate font-mono" style={{ color: "var(--text-3)" }}>
                {p.websiteUrl.replace(/^https?:\/\//, "")}
                {p.scopePrefix && <span style={{ color: "var(--indigo)" }}>{p.scopePrefix}</span>}
              </p>
            </div>
            {/* Spacer for trash button area */}
            <div className="w-8 flex-shrink-0" />
            {hasScore && (
              <span className={`grade grade-${grade} ml-1 flex-shrink-0`}>{grade}</span>
            )}
          </div>

          {/* Score + trend */}
          <div className="flex items-end gap-3 mb-4">
            <div>
              <div className="text-4xl font-bold leading-none" style={{
                color: hasScore ? scoreColor(score!) : "var(--text-3)"
              }}>
                {hasScore ? score : "—"}
              </div>
              <div className="text-xs mt-1" style={{ color: "var(--text-3)" }}>LLM readiness score</div>
            </div>
            {delta != null && (
              <div className={`flex items-center gap-1 text-sm font-medium pb-1 ${delta > 0 ? "trend-up" : delta < 0 ? "trend-down" : "trend-flat"}`}>
                {delta > 0 ? "↑" : delta < 0 ? "↓" : "→"}
                {Math.abs(delta)} pts
              </div>
            )}
          </div>

          {/* Mini score bar */}
          {hasScore && (
            <div className="progress-track mb-4">
              <div className="progress-fill" style={{
                width: `${score}%`,
                background: scoreBarColor(score!),
              }} />
            </div>
          )}

          {/* Footer row */}
          <div className="flex items-center justify-between text-xs" style={{ color: "var(--text-3)" }}>
            <span>
              {p.runCount > 0 ? `${p.runCount} run${p.runCount !== 1 ? "s" : ""}` : "Not yet audited"}
              {p.lastAuditedAt && ` · ${timeAgo(p.lastAuditedAt)}`}
            </span>
            <span style={{ color: "var(--indigo)" }}>View →</span>
          </div>
        </div>
      </Link>

      {/* Trash button — absolutely positioned top-right, visible on hover */}
      <div className="absolute top-3 right-3 z-10">
        <DeleteProjectButton projectId={p.id} />
      </div>
    </div>
  );
}

function NewProjectCard() {
  return (
    <Link href="/projects/new"
      className="card card-interactive flex flex-col items-center justify-center p-8 text-center anim-fade-up stagger-6"
      style={{ border: "1px dashed rgba(99,102,241,0.3)", minHeight: "200px" }}>
      <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-3"
        style={{ background: "rgba(99,102,241,0.1)" }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
      </div>
      <p className="font-medium text-sm" style={{ color: "#4f46e5" }}>New Project</p>
      <p className="text-xs mt-1" style={{ color: "var(--text-3)" }}>Add a client + competitors</p>
    </Link>
  );
}

function EmptyState() {
  return (
    <div className="anim-scale-in flex flex-col items-center justify-center py-24 text-center">
      <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-6"
        style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.15)" }}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.5">
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
      </div>
      <h2 className="text-xl font-semibold mb-2" style={{ color: "var(--text-1)" }}>No projects yet</h2>
      <p className="mb-8 max-w-sm" style={{ color: "var(--text-2)" }}>
        Create your first project to start auditing content and tracking LLM readiness scores over time.
      </p>
      <Link href="/projects/new" className="btn-primary">Create your first project</Link>
    </div>
  );
}

function scoreColor(s: number) {
  if (s >= 80) return "#059669";
  if (s >= 65) return "#2563eb";
  if (s >= 50) return "#d97706";
  if (s >= 35) return "#ea580c";
  return "#dc2626";
}

function scoreBarColor(s: number) {
  if (s >= 80) return "#10b981";
  if (s >= 65) return "#3b82f6";
  if (s >= 50) return "#f59e0b";
  if (s >= 35) return "#f97316";
  return "#ef4444";
}

function timeAgo(date: Date): string {
  const diff = Date.now() - date.getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
