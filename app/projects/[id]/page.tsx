// ─────────────────────────────────────────────────────────────
//  /projects/[id] — Overview (the guided "start here" surface).
//  The old single-page hub was split into the left-rail sections
//  (see layout.tsx). Overview keeps orientation + direction:
//  score ring, setup checklist, fix-first queue, score trend and
//  section tiles. The heavy surfaces live in their own routes:
//  /pages, /visibility, /competitors, /optimize, /reports,
//  /settings.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import TrendChart from "@/components/TrendChart";
import RunButton from "@/components/RunButton";
import LiveAuditBanner from "@/components/LiveAuditBanner";
import InfoTip from "@/components/InfoTip";
import AiCrawlerTile from "@/components/AiCrawlerTile";
import { getSerpRollup, getLatestSerpJobId, getSerpPageSummaries } from "@/lib/db/serp";
import { getRankRollup } from "@/lib/rankings/rollup";
import { getPromptRows } from "@/lib/db/prompts";
import { serpConfigured } from "@/lib/serp/semrush";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";
import type { ScoreDimension } from "@/lib/types";
import {
  COMPETITOR_COLORS,
  hubSql,
  scoreColor,
  gradeColor,
  medianGrade,
  computeQuickSummary,
  getLatestScores,
  buildOptimizedRows,
  buildFixFirst,
  getActiveJobs,
  getLastRunFailure,
  isStaleBaseline,
} from "@/lib/hub";

export const revalidate = 0;

export default async function ProjectOverviewPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const sql = hubSql();
  const { latestScoresMap, clientScores, clientJobId, hasResults } = await getLatestScores(params.id);
  const summary = hasResults ? computeQuickSummary(clientScores) : null;
  const clientMedianGrade = medianGrade(clientScores);

  const optimizeStates = hasResults ? await getProjectOptimizeStates(params.id) : {};
  const optimizedRows = buildOptimizedRows(clientScores, optimizeStates);
  const staleBaseline = await isStaleBaseline(clientJobId);

  // ── AI-crawler access (latest check for the client site) ──
  type AiAccessData = {
    checkedAt: string;
    origin: string;
    robotsFound: boolean;
    llmsTxtFound: boolean;
    robotsReachable?: boolean;
    robotsStatus?: number | null;
    bots: {
      name: string;
      status: "allowed" | "blocked" | "partial" | "unknown";
      sampleRule: string | null;
    }[];
  };
  const aiAccessRows = await sql`
    SELECT ai_access FROM audit_jobs
    WHERE project_id = ${params.id} AND competitor_id IS NULL AND ai_access IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const aiAccess = (aiAccessRows[0]?.ai_access ?? null) as AiAccessData | null;
  const blockedBots = aiAccess?.bots.filter((b) => b.status === "blocked") ?? [];

  // ── Search visibility roll-up + per-page facts ──
  const serpEnabled = serpConfigured() || dfsConfigured();
  let serpRollup = null as Awaited<ReturnType<typeof getSerpRollup>>;
  let serpSummaries: Awaited<ReturnType<typeof getSerpPageSummaries>> | undefined;
  const serpJobId = await getLatestSerpJobId(params.id).catch(() => null);
  if (serpJobId) {
    serpRollup = await getSerpRollup(serpJobId).catch(() => null);
    serpSummaries = await getSerpPageSummaries(serpJobId).catch(() => undefined);
  }

  // Traditional Google rankings (2026-07-31) — observed organic positions
  // from the same stored snapshots; zero extra API calls.
  const rankRollup = serpJobId ? await getRankRollup(params.id).catch(() => null) : null;
  const rankAvgDelta =
    rankRollup && rankRollup.avgPosition !== null && rankRollup.prevAvgPosition !== null
      ? Math.round((rankRollup.prevAvgPosition - rankRollup.avgPosition) * 10) / 10
      : null;

  // LLM prompts roll-up (management lives on the workbench — URL-level model).
  const promptRows = await getPromptRows(params.id).catch(() => []);
  const promptSummary = (() => {
    if (promptRows.length === 0) return null;
    let checked = 0;
    let cited = 0;
    for (const r of promptRows) {
      const ok = Object.values(r.checks).filter((c) => c && c.status === "ok");
      if (ok.length === 0) continue;
      checked++;
      if (ok.some((c) => c!.cited)) cited++;
    }
    return { total: promptRows.length, checked, cited };
  })();

  const activeJobs = await getActiveJobs(params.id);
  const isRunning = activeJobs.length > 0;

  // If the most recent client run FAILED, say so here. Without this the page
  // renders identically to a page where nothing was ever clicked — which is
  // precisely how "Run Audit does nothing" presented. Also restores the
  // blocked-site alert that was lost when this page moved to the left rail.
  const lastFailure = isRunning ? null : await getLastRunFailure(params.id).catch(() => null);

  // ── Setup checklist (all states derived from real data) ──
  const fixFirst = hasResults ? buildFixFirst(clientScores, serpSummaries) : [];
  const weakestPage = fixFirst[0] ?? null;
  const checklist: { label: string; done: boolean; href?: string; cta?: string }[] = [
    { label: "Run your first audit", done: hasResults },
    {
      label: "Add competitors to benchmark against",
      done: project.competitors.length > 0,
      href: `/projects/${params.id}/competitors`,
      cta: "Add",
    },
    ...(serpEnabled
      ? [
          {
            label: "Pull search visibility data",
            done: serpJobId != null,
            href: `/projects/${params.id}/visibility`,
            cta: "View",
          },
        ]
      : []),
    {
      label: "Optimize your first page",
      done: optimizedRows.length > 0,
      href: weakestPage ? `/projects/${params.id}/optimize/${weakestPage.pageId}` : undefined,
      cta: "Start",
    },
  ];
  const checklistDone = checklist.filter((c) => c.done).length;
  const showChecklist = checklistDone < checklist.length;

  // ── Competitor tile facts ──
  const competitorFact = (() => {
    if (!hasResults || project.competitors.length === 0) return null;
    let top: { name: string; avg: number; dimsBeaten: number } | null = null;
    for (const c of project.competitors) {
      const cs = latestScoresMap[c.id] ?? [];
      if (cs.length === 0) continue;
      const cSummary = computeQuickSummary(cs);
      const dimsBeaten = ALL_DIMENSIONS.filter(
        (d: ScoreDimension) => cSummary.averageByDimension[d] > (summary?.averageByDimension[d] ?? 0)
      ).length;
      if (!top || cSummary.averageScore > top.avg) {
        top = { name: c.name, avg: cSummary.averageScore, dimsBeaten };
      }
    }
    return top;
  })();

  const needsWorkCount = clientScores.filter((s) => s.grade === "D" || s.grade === "F").length;
  const verifiedCount = optimizedRows.filter((r) => r.verified).length;

  const overall = project.latestScore ?? summary?.averageScore ?? null;
  const strongest = summary ? summary.topIssues[summary.topIssues.length - 1] : null;
  const weakestDim = summary ? summary.topIssues[0] : null;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      {/* ── Header ─────────────────────────────────────────────
          `relative z-30` is LOAD-BEARING. Cards below carry .anim-fade-up,
          whose fill-mode:both leaves a permanent transform — a stacking
          context. Without a z-index here the AiCrawlerTile / InfoTip popovers
          paint under later siblings (see components/InfoTip.tsx). */}
      <div className="anim-fade-up relative z-30 flex items-start justify-between gap-4 flex-wrap">
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
            {project.auditSource === "domain" && project.scopePrefix && (
              <span style={{ color: "var(--indigo)" }}>{project.scopePrefix}</span>
            )}
          </p>
          {project.auditSource !== "domain" && (
            <span
              className="inline-block mt-2 px-2 py-0.5 rounded-md text-xs font-medium"
              style={{ background: "rgba(99,102,241,0.12)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.2)" }}
            >
              {project.auditSource === "single"
                ? "Single page"
                : `URL list · ${project.sourceUrls?.length ?? 0} page${(project.sourceUrls?.length ?? 0) !== 1 ? "s" : ""}`}
            </span>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 flex-wrap">
          {aiAccess && <AiCrawlerTile data={aiAccess} />}
          <div className="flex flex-col items-end gap-1.5">
            <div className="flex items-center gap-2">
              {hasResults && (
                <a
                  href={`/api/projects/${params.id}/report`}
                  className="inline-flex items-center gap-1.5 text-sm px-4 py-1.5 rounded-lg border transition-colors hover:border-slate-300"
                  style={{ background: "var(--bg-1)", borderColor: "var(--border)", color: "var(--text-2)" }}
                  title="Download the client-ready PDF assessment from the latest completed run"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                    <polyline points="7 10 12 15 17 10" />
                    <line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Assessment
                </a>
              )}
              <RunButton projectId={params.id} hasCompetitors={project.competitors.length > 0} />
            </div>
            {staleBaseline && !isRunning && (
              <p className="text-[10.5px] text-amber-600 text-right max-w-[200px] leading-snug">
                ⚠ Re-run before optimizing — current scores are from an older scoring engine
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Active run banner (live progress) ─────────────── */}
      {isRunning && <LiveAuditBanner initialJobs={activeJobs as any} projectId={params.id} />}

      {/* ── Last run failed ──────────────────────────────── */}
      {lastFailure && (
        <div
          className="anim-fade-up card px-5 py-3.5"
          style={{ border: "1px solid rgba(245,158,11,0.45)", background: "rgba(245,158,11,0.06)" }}
          role="alert"
        >
          <p className="text-sm" style={{ color: "#b45309" }}>
            <span className="font-semibold">The last audit run didn&apos;t complete.</span>{" "}
            {lastFailure.message}
          </p>
        </div>
      )}

      {/* ── AI crawler access — BLOCKED only. The all-allowed and partial
          states live in the compact AiCrawlerTile in the header. A hard block
          keeps the full-width bar: it's the highest-value finding the audit
          produces. Don't collapse this one to save space. */}
      {aiAccess && blockedBots.length > 0 && (
        <div
          className="anim-fade-up card px-5 py-3.5"
          style={{ border: "1px solid rgba(220,38,38,0.35)", background: "rgba(239,68,68,0.04)" }}
        >
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm" style={{ color: "#dc2626" }}>
              <span className="font-semibold">
                Your site blocks {blockedBots.length} of {aiAccess.bots.length} AI crawlers
              </span>{" "}
              in robots.txt — those engines can&apos;t fetch your pages at all. No content fix changes
              that until access is opened.
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              {blockedBots.map((b) => (
                <span
                  key={b.name}
                  title={b.sampleRule ? `robots.txt: ${b.sampleRule}` : `No restricting rule for ${b.name}`}
                  className="px-2.5 py-1 rounded-full text-xs font-semibold"
                  style={{ background: "rgba(239,68,68,0.12)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.3)" }}
                >
                  {b.name} ✕ blocked
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Hero: score ring + setup checklist ───────────── */}
      <div className={`grid gap-4 ${showChecklist && hasResults ? "lg:grid-cols-[1fr_1.3fr]" : "grid-cols-1"}`}>
        {hasResults && overall != null && (
          <div className="anim-fade-up card p-5 flex items-center gap-5">
            <div
              className="rounded-full flex items-center justify-center flex-shrink-0"
              style={{
                width: 104,
                height: 104,
                background: `conic-gradient(${scoreColor(overall)} 0% ${overall}%, var(--bg-3) ${overall}% 100%)`,
              }}
              role="img"
              aria-label={`Overall LLM readiness score ${overall} out of 100`}
            >
              <div
                className="rounded-full flex flex-col items-center justify-center"
                style={{ width: 80, height: 80, background: "var(--bg-1)" }}
              >
                <span className="text-[26px] font-extrabold leading-none" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
                  {overall}
                </span>
                {clientMedianGrade && (
                  <span className="text-[10.5px] font-bold mt-0.5" style={{ color: gradeColor(clientMedianGrade) }}>
                    MEDIAN {clientMedianGrade}
                  </span>
                )}
              </div>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--text-1)" }}>
                LLM readiness score
                <InfoTip
                  title="Overall score"
                  text="The average overall LLM-readiness score (0–100) across all pages in the latest completed audit run, weighted across all ten scoring dimensions. The median letter grade shows the typical page — a few very strong or weak pages can't skew it."
                />
              </p>
              <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--text-3)" }}>
                Scored across {ALL_DIMENSIONS.length} dimensions on {clientScores.length} page{clientScores.length === 1 ? "" : "s"}.
              </p>
              {strongest && weakestDim && (
                <p className="text-xs mt-2" style={{ color: "var(--text-2)" }}>
                  <span className="font-semibold" style={{ color: "#059669" }}>Strongest:</span>{" "}
                  {DIMENSION_LABELS[strongest.dimension as ScoreDimension]} ({strongest.averageScore})
                  {" · "}
                  <span className="font-semibold" style={{ color: "#dc2626" }}>Weakest:</span>{" "}
                  {DIMENSION_LABELS[weakestDim.dimension as ScoreDimension]} ({weakestDim.averageScore})
                </p>
              )}
              {rankRollup && rankRollup.ranked > 0 && (
                <p className="text-xs mt-1.5" style={{ color: "var(--text-2)" }}>
                  <span className="font-semibold" style={{ color: "#4f46e5" }}>Google:</span>{" "}
                  {rankRollup.top10} of {rankRollup.tracked} keywords in the top 10 · avg position{" "}
                  {rankRollup.avgPosition}
                  {rankAvgDelta !== null && rankAvgDelta !== 0 && (
                    <span
                      className="font-semibold"
                      style={{ color: rankAvgDelta > 0 ? "#059669" : "#dc2626" }}
                    >
                      {" "}({rankAvgDelta > 0 ? `▲${rankAvgDelta}` : `▼${Math.abs(rankAvgDelta)}`})
                    </span>
                  )}
                </p>
              )}
            </div>
          </div>
        )}

        {showChecklist && (
          <div className="anim-fade-up stagger-1 card p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                {hasResults ? "Set up this project" : "Get started"}
              </p>
              <p className="text-[11.5px] font-semibold" style={{ color: "var(--text-3)" }}>
                {checklistDone} of {checklist.length} done
              </p>
            </div>
            <div className="mt-2">
              {checklist.map((item, i) => {
                const isNext = !item.done && checklist.slice(0, i).every((p) => p.done);
                return (
                  <div
                    key={item.label}
                    className="flex items-center gap-3 py-2 text-[13px]"
                    style={{ borderTop: i > 0 ? "1px solid var(--border)" : "none" }}
                  >
                    <span
                      className="w-[18px] h-[18px] rounded-full flex-shrink-0 inline-flex items-center justify-center text-[11px]"
                      style={
                        item.done
                          ? { background: "rgba(5,150,105,0.14)", color: "#059669" }
                          : isNext
                            ? { border: "2px solid #6366f1" }
                            : { border: "2px solid var(--bg-4, #d3dae6)" }
                      }
                    >
                      {item.done ? "✓" : ""}
                    </span>
                    <span
                      className={isNext ? "font-semibold" : ""}
                      style={{
                        color: item.done ? "var(--text-3)" : "var(--text-1)",
                        textDecoration: item.done ? "line-through" : "none",
                      }}
                    >
                      {item.label}
                    </span>
                    {!item.done && item.href && (
                      <Link
                        href={item.href}
                        className="ml-auto text-xs font-semibold hover:underline whitespace-nowrap"
                        style={{ color: "#4f46e5" }}
                      >
                        {item.cta ?? "Open"} →
                      </Link>
                    )}
                  </div>
                );
              })}
            </div>
            {!hasResults && !isRunning && (
              <p className="text-xs mt-3 leading-relaxed" style={{ color: "var(--text-3)" }}>
                Kick off your first audit with <span className="font-semibold">Run Audit</span> above — pages are
                crawled, scored on {ALL_DIMENSIONS.length} dimensions, and this page fills in as results land.
              </p>
            )}
          </div>
        )}
      </div>

      {/* ── Fix these first ──────────────────────────────── */}
      {fixFirst.length > 0 && (
        <div className="anim-fade-up stagger-2 card overflow-hidden">
          <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-1">
            <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--text-1)" }}>
              Fix these first
              <InfoTip
                title="Fix these first"
                text="Pages ranked by how much weighted headroom they have across the ten scoring dimensions — concentrated weaknesses in heavily-weighted dimensions rank above a uniformly mediocre page. The dimension scores shown are the page's real audit scores."
              />
            </p>
            <Link
              href={`/projects/${params.id}/optimize`}
              className="text-xs font-semibold hover:underline"
              style={{ color: "#4f46e5" }}
            >
              Full queue →
            </Link>
          </div>
          {fixFirst.map((f, i) => (
            <div
              key={f.pageId}
              className="flex items-center gap-4 px-5 py-3"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              <span
                className="w-6 h-6 rounded-lg flex-shrink-0 inline-flex items-center justify-center text-xs font-extrabold"
                style={{ background: "rgba(99,102,241,0.1)", color: "#4f46e5" }}
              >
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-semibold truncate flex items-center gap-2" style={{ color: "var(--text-1)" }}>
                  <span className="truncate">{pathOf(f.url)}</span>
                  <span
                    className="inline-flex items-center justify-center text-[10.5px] font-bold rounded px-1.5 py-px flex-shrink-0"
                    style={{ background: `${gradeColor(f.grade)}1f`, color: gradeColor(f.grade), border: `1px solid ${gradeColor(f.grade)}40` }}
                  >
                    {f.grade} · {f.overall}
                  </span>
                </p>
                <p className="text-xs mt-0.5 truncate" style={{ color: "var(--text-3)" }}>
                  {f.weakest.map((w) => `${w.label} ${w.score}`).join(" · ")}
                  {f.serpFacts.length > 0 && ` — ${f.serpFacts[0]}`}
                </p>
              </div>
              <Link
                href={`/projects/${params.id}/optimize/${f.pageId}`}
                className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg ${i === 0 ? "btn-primary" : "hover:underline"}`}
                style={i === 0 ? undefined : { color: "#4f46e5" }}
              >
                Open workbench
              </Link>
            </div>
          ))}
        </div>
      )}

      {/* ── Score trend ──────────────────────────────────── */}
      {project.history.length > 1 && (
        <div className="anim-fade-up stagger-3 card p-5">
          <p className="section-label">Score over time</p>
          <TrendChart
            history={project.history}
            competitors={project.competitors}
            competitorColors={COMPETITOR_COLORS}
          />
        </div>
      )}

      {/* ── Section tiles (teach the rail by using it) ───── */}
      {hasResults && (
        <div className="grid sm:grid-cols-3 gap-4">
          <Link
            href={`/projects/${params.id}/visibility`}
            className="anim-fade-up stagger-3 card card-interactive p-4 block"
          >
            <p className="text-xs font-bold" style={{ color: "var(--text-1)" }}>🔍 Visibility</p>
            <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: "var(--text-2)" }}>
              {serpRollup
                ? `Cited in ${serpRollup.aioCitedKws} of ${serpRollup.aioTriggeredKws} AI Overview keywords · you own ${serpRollup.paaQuestionsOwned} of ${serpRollup.paaQuestionsTotal} PAA questions${rankRollup && rankRollup.ranked > 0 ? ` · ${rankRollup.top10} of ${rankRollup.tracked} keywords rank top-10 in Google` : ""}${promptSummary && promptSummary.checked > 0 ? ` · ${promptSummary.cited} of ${promptSummary.checked} checked LLM prompts cite you` : ""}.`
                : serpEnabled
                  ? "No search visibility data yet — it's pulled automatically with each audit run."
                  : "Search visibility isn't configured — add a DataForSEO or Semrush key to pull AIO + PAA data."}
            </p>
            <p className="text-xs font-semibold mt-2" style={{ color: "#4f46e5" }}>
              {serpRollup ? "See where you're losing →" : "Learn more →"}
            </p>
          </Link>
          <Link
            href={`/projects/${params.id}/competitors`}
            className="anim-fade-up stagger-4 card card-interactive p-4 block"
          >
            <p className="text-xs font-bold" style={{ color: "var(--text-1)" }}>👥 Competitors</p>
            <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: "var(--text-2)" }}>
              {competitorFact
                ? `${competitorFact.name} averages ${competitorFact.avg} vs your ${summary?.averageScore} — ahead of you on ${competitorFact.dimsBeaten} of ${ALL_DIMENSIONS.length} dimensions.`
                : project.competitors.length > 0
                  ? "Competitors are set up — run an audit to score them side-by-side."
                  : "No competitors tracked yet. Add the sites you're losing AI answers to."}
            </p>
            <p className="text-xs font-semibold mt-2" style={{ color: "#4f46e5" }}>
              {competitorFact ? "Compare head-to-head →" : "Add competitors →"}
            </p>
          </Link>
          <Link
            href={`/projects/${params.id}/optimize`}
            className="anim-fade-up stagger-5 card card-interactive p-4 block"
          >
            <p className="text-xs font-bold" style={{ color: "var(--text-1)" }}>✏️ Optimize</p>
            <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: "var(--text-2)" }}>
              {optimizedRows.length > 0
                ? `${optimizedRows.length} page${optimizedRows.length === 1 ? "" : "s"} in progress · ${verifiedCount} verified live${needsWorkCount > 0 ? ` · ${needsWorkCount} more need${needsWorkCount === 1 ? "s" : ""} work` : ""}.`
                : needsWorkCount > 0
                  ? `${needsWorkCount} page${needsWorkCount === 1 ? "" : "s"} graded D or F — the workbench rewrites, simulates, and re-scores them.`
                  : "Every page grades C or better. Push your B pages toward A in the workbench."}
            </p>
            <p className="text-xs font-semibold mt-2" style={{ color: "#4f46e5" }}>Open the queue →</p>
          </Link>
        </div>
      )}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}
