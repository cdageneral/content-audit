import { notFound } from "next/navigation";
import Link from "next/link";
import { getProjectDetail } from "@/lib/db/projects";
import { getScoresByJob } from "@/lib/db/client";
import { neon } from "@neondatabase/serverless";
import TrendChart from "@/components/TrendChart";
import CompetitorMatrix from "@/components/CompetitorMatrix";
import RunButton from "@/components/RunButton";
import AddCompetitorForm from "@/components/AddCompetitorForm";
import AuditResults from "@/components/AuditResults";
import LiveAuditBanner from "@/components/LiveAuditBanner";

export const revalidate = 0;

const COMPETITOR_COLORS = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0284c7"];

export default async function ProjectHubPage({
  params,
}: {
  params: { id: string };
}) {
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  // Load latest scores for client + each competitor
  const sql = neon(process.env.DATABASE_URL!);
  const latestJobs = await sql`
    SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
      id, competitor_id, completed_at, status
    FROM audit_jobs
    WHERE project_id = ${params.id} AND status = 'done'
    ORDER BY COALESCE(competitor_id::text, 'client'), completed_at DESC
  `.catch(() => []);

  const latestScoresMap: Record<string, Awaited<ReturnType<typeof getScoresByJob>>> = {};
  for (const job of latestJobs) {
    const key = job.competitor_id ? String(job.competitor_id) : "client";
    latestScoresMap[key] = await getScoresByJob(job.id as string).catch(() => []);
  }

  const clientScores = latestScoresMap["client"] ?? [];
  const hasResults = clientScores.length > 0;

  // In-progress jobs (for status banner)
  // Only jobs created in the last 2 hours to avoid showing stale stuck jobs
  const activeJobs = await sql`
    SELECT id, competitor_id, status, crawled_pages, total_pages, scored_pages
    FROM audit_jobs
    WHERE project_id = ${params.id}
      AND status NOT IN ('done', 'failed')
      AND created_at > NOW() - INTERVAL '2 hours'
    ORDER BY created_at DESC LIMIT 5
  `.catch(() => []);

  // Auto-expire jobs older than 2 hours that are still stuck — mark them failed
  await sql`
    UPDATE audit_jobs
    SET status = 'failed', error_message = 'Timed out — job exceeded 2 hour limit'
    WHERE project_id = ${params.id}
      AND status NOT IN ('done', 'failed')
      AND created_at <= NOW() - INTERVAL '2 hours'
  `.catch(() => null);

  // Sites whose MOST RECENT audit was stopped because they block crawling.
  const latestByTarget = await sql`
    SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
      id, url, status, error_message
    FROM audit_jobs
    WHERE project_id = ${params.id}
    ORDER BY COALESCE(competitor_id::text, 'client'), created_at DESC
  `.catch(() => []);
  const blockedJobs = (latestByTarget as any[]).filter(
    (j) =>
      j.status === "failed" &&
      String(j.error_message ?? "").toLowerCase().includes("blocks automated crawling")
  );

  const isRunning = activeJobs.length > 0;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-8">
      {/* ── Header ─────────────────────────────────────────── */}
      <div className="anim-fade-up flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/" className="text-xs hover:underline" style={{ color: "var(--text-3)" }}>
              Dashboard
            </Link>
            <span style={{ color: "var(--text-3)" }}>/</span>
            <span className="text-xs" style={{ color: "var(--text-2)" }}>{project.clientName}</span>
          </div>
          <h1 className="text-3xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
            {project.clientName}
          </h1>
          <p className="text-sm font-mono mt-1" style={{ color: "var(--text-3)" }}>
            {project.websiteUrl}
            {project.scopePrefix && (
              <span style={{ color: "var(--indigo)" }}>{project.scopePrefix}</span>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {project.latestScore != null && (
            <div className="text-center px-5 py-3 rounded-xl" style={{ background: "var(--bg-1)", border: "1px solid var(--border)" }}>
              <div className="text-3xl font-bold" style={{ color: scoreColor(project.latestScore) }}>
                {project.latestScore}
              </div>
              <div className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>Latest score</div>
            </div>
          )}
          <RunButton projectId={params.id} hasCompetitors={project.competitors.length > 0} />
        </div>
      </div>

      {/* ── Active run banner (live progress) ─────────────── */}
      {isRunning && (
        <LiveAuditBanner initialJobs={activeJobs as any} projectId={params.id} />
      )}

      {/* ── Blocked-site alert ─────────────────────────────── */}
      {blockedJobs.length > 0 && (
        <div
          className="anim-slide-r rounded-xl p-4 space-y-2"
          style={{ background: "rgba(251,191,36,0.1)", border: "1px solid rgba(251,191,36,0.35)" }}
        >
          <div className="flex items-center gap-2">
            <svg
              className="h-4 w-4 flex-shrink-0"
              style={{ color: "#d97706" }}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
              />
            </svg>
            <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
              {blockedJobs.length === 1
                ? "A site blocks automated crawling"
                : "Some sites block automated crawling"}
            </p>
          </div>
          {blockedJobs.map((j) => (
            <p key={String(j.id)} className="text-xs pl-6" style={{ color: "var(--text-2)" }}>
              <span className="font-mono" style={{ color: "var(--text-1)" }}>
                {String(j.url).replace(/^https?:\/\//, "")}
              </span>{" "}
              — {String(j.error_message)}
            </p>
          ))}
        </div>
      )}

      {/* ── Score trend chart ──────────────────────────────── */}
      {project.history.length > 1 && (
        <div className="anim-fade-up stagger-1 card p-5">
          <p className="section-label">Score over time</p>
          <TrendChart
            history={project.history}
            competitors={project.competitors}
            competitorColors={COMPETITOR_COLORS}
          />
        </div>
      )}

      {/* ── Competitor matrix ──────────────────────────────── */}
      {project.competitors.length > 0 && hasResults && (
        <div className="anim-fade-up stagger-2 card overflow-hidden">
          <div className="p-5 border-b" style={{ borderColor: "var(--border)" }}>
            <p className="section-label mb-0">Competitive comparison — latest scores</p>
          </div>
          <CompetitorMatrix
            clientName={project.clientName}
            clientScores={clientScores}
            competitors={project.competitors}
            competitorScoresMap={latestScoresMap}
            competitorColors={COMPETITOR_COLORS}
          />
        </div>
      )}

      {/* ── Full audit results (client) ────────────────────── */}
      {hasResults && (
        <div className="anim-fade-up stagger-3">
          <p className="section-label">{project.clientName} — page-level results</p>
          <AuditResults
            job={{ id: latestJobs[0]?.id as string } as any}
            scores={clientScores}
            summary={computeQuickSummary(clientScores)}
          />
        </div>
      )}

      {/* ── Bottom row: competitors + add ─────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 anim-fade-up stagger-4">
        {/* Competitor list */}
        <div className="card p-5">
          <p className="section-label">Tracked competitors</p>
          {project.competitors.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-3)" }}>
              No competitors added yet. Add one below to start comparing.
            </p>
          ) : (
            <div className="space-y-3">
              {project.competitors.map((c) => (
                <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg"
                  style={{ background: "var(--bg-2)" }}>
                  <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: COMPETITOR_COLORS[c.colorIndex] }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "var(--text-1)" }}>
                      {c.name}
                    </p>
                    <p className="text-xs font-mono truncate" style={{ color: "var(--text-3)" }}>
                      {c.url.replace(/^https?:\/\//, "")}
                    </p>
                  </div>
                  {c.latestScore != null ? (
                    <div className="text-right flex-shrink-0">
                      <span className="text-lg font-bold" style={{ color: scoreColor(c.latestScore) }}>
                        {c.latestScore}
                      </span>
                      {c.scoreDelta != null && (
                        <div className={`text-xs ${c.scoreDelta > 0 ? "trend-up" : c.scoreDelta < 0 ? "trend-down" : "trend-flat"}`}>
                          {c.scoreDelta > 0 ? "+" : ""}{c.scoreDelta}
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs" style={{ color: "var(--text-3)" }}>Not audited</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Add competitor */}
        <div className="card p-5">
          <p className="section-label">Add a competitor</p>
          <AddCompetitorForm projectId={params.id} />
        </div>
      </div>
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

function computeQuickSummary(scores: Awaited<ReturnType<typeof getScoresByJob>>) {
  if (!scores.length) return null as any;
  const dims = ["coreIntent","edgeCases","impliedQuestions","fanOutQueries","retrievable","extractable","citable","reusable"] as const;
  const avg = (d: typeof dims[number]) => Math.round(scores.reduce((s,p) => s + p.scores[d], 0) / scores.length);
  const avgByDim = Object.fromEntries(dims.map(d => [d, avg(d)])) as any;
  const avgScore = Math.round(scores.reduce((s,p) => s + p.overallScore, 0) / scores.length);
  const grades: Record<string,number> = {A:0,B:0,C:0,D:0,F:0};
  scores.forEach(s => grades[s.grade] = (grades[s.grade]||0) + 1);
  const topIssues = dims.map(d => ({ dimension: d, affectedPages: scores.filter(s => s.scores[d] < 50).length, averageScore: avgByDim[d] })).sort((a,b) => a.averageScore - b.averageScore).slice(0,4);
  const sorted = [...scores].sort((a,b) => b.overallScore - a.overallScore);
  return { totalPages: scores.length, averageScore: avgScore, averageByDimension: avgByDim, gradeDistribution: grades, topIssues, topPages: sorted.slice(0,5).map(s => ({url:s.url,score:s.overallScore})), bottomPages: sorted.slice(-5).reverse().map(s => ({url:s.url,score:s.overallScore})) };
}
