import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail, refreshCompetitorCache, refreshProjectCache } from "@/lib/db/projects";
import { getScoresByJob } from "@/lib/db/client";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import { enqueueScoreBatch } from "@/lib/queue/qstash";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";
import { neon } from "@neondatabase/serverless";
import TrendChart from "@/components/TrendChart";
import CompetitorMatrix from "@/components/CompetitorMatrix";
import RunButton from "@/components/RunButton";
import AuditResults from "@/components/AuditResults";
import OptimizedSummary from "@/components/OptimizedSummary";
import LiveAuditBanner from "@/components/LiveAuditBanner";
import InfoTip from "@/components/InfoTip";
import EditAuditSourceButton from "@/components/EditAuditSourceButton";
import SearchVisibilityCard from "@/components/SearchVisibilityCard";
import { getSerpRollup, getLatestSerpJobId } from "@/lib/db/serp";
import { serpConfigured } from "@/lib/serp/semrush";

export const revalidate = 0;

const COMPETITOR_COLORS = ["#dc2626", "#ea580c", "#ca8a04", "#16a34a", "#0284c7"];

export default async function ProjectHubPage({
  params,
}: {
  params: { id: string };
}) {
  // Block the hub for anyone not in the project's company (no-op unless
  // AUTH_ENFORCED). Not your company's project → back to the list.
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  // Load latest scores for client + each competitor.
  // no-store: the Neon driver reads via fetch, which Next.js caches by default;
  // without this the hub can render a stale snapshot (see lib/db/client.ts).
  const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });

  // -- Self-heal: reconcile jobs stuck in 'scoring'/'crawling' against the
  //    ACTUAL page_scores rows. Two failure modes are covered:
  //      (a) fully scored but never flipped to 'done' (counter bug / a batch
  //          that died right before its done-check) -> finalize now.
  //      (b) a crawl-claim race left some pages un-dispatched: the last crawl
  //          batch grabbed the 'scoring' lock and dispatched the pages then in
  //          the DB while an earlier concurrent batch was still committing more
  //          pages, so those late pages were never sent to a score_batch and
  //          the job can never reach "fully scored" on its own -> re-dispatch
  //          just the un-scored pages. The score webhook's row-count done-check
  //          then finalizes the job when the last stragglers land.
  //    Cheap: only touches this project's not-yet-final jobs.
  const stuckJobs = await sql`
    SELECT id, competitor_id, weights, updated_at
    FROM audit_jobs
    WHERE project_id = ${params.id} AND status IN ('scoring', 'crawling')
  `.catch(() => [] as Record<string, unknown>[]);
  for (const j of stuckJobs) {
    const jobId = j.id as string;
    const pageRows = await sql`SELECT id FROM audit_pages WHERE job_id = ${jobId}`.catch(() => [] as Record<string, unknown>[]);
    if (pageRows.length === 0) continue; // nothing crawled yet — leave it alone
    const scoredRows = await sql`SELECT page_id FROM page_scores WHERE job_id = ${jobId}`.catch(() => [] as Record<string, unknown>[]);
    const scoredSet = new Set(scoredRows.map((r) => String(r.page_id)));
    const unscored = pageRows.map((p) => String(p.id)).filter((id) => !scoredSet.has(id));

    if (unscored.length === 0) {
      // (a) fully scored — finalize and refresh the cached score.
      await sql`
        UPDATE audit_jobs SET status = 'done', completed_at = NOW()
        WHERE id = ${jobId} AND status IN ('scoring', 'crawling')
      `.catch(() => null);
      if (j.competitor_id) {
        await refreshCompetitorCache(String(j.competitor_id)).catch(() => null);
      } else {
        await refreshProjectCache(params.id).catch(() => null);
      }
    } else {
      // (b) orphaned un-scored pages — re-dispatch them. Guard on updated_at so
      // we don't re-enqueue on every render while a batch is still in flight.
      const updatedAt = j.updated_at ? new Date(j.updated_at as string).getTime() : 0;
      if (Date.now() - updatedAt > 90_000) {
        const weights = { ...DEFAULT_WEIGHTS, ...((j.weights as object) ?? {}) } as DimensionScores;
        for (let i = 0; i < unscored.length; i += 10) {
          await enqueueScoreBatch({ jobId, pageIds: unscored.slice(i, i + 10), weights }).catch(() => null);
        }
        // Touch the job so the guard above suppresses duplicate dispatches
        // until this batch has had time to land (or fail and be retried).
        await sql`UPDATE audit_jobs SET updated_at = NOW() WHERE id = ${jobId}`.catch(() => null);
      }
    }
  }

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

  // Optimization state (saved drafts / simulated scores / verifications) for
  // this project's URLs. Read-only + sandboxed — drives the row badges and the
  // Optimized-pages summary; returns {} on any error so the hub still renders.
  const optimizeStates = hasResults
    ? await getProjectOptimizeStates(params.id)
    : {};
  const optimizedRows = clientScores
    .filter((s) => optimizeStates[s.url])
    .map((s) => {
      const st = optimizeStates[s.url];
      return {
        url: s.url,
        pageId: s.pageId,
        baseline: s.overallScore,
        simulated: st.simulatedOverall,
        grade: st.simulatedGrade,
        version: st.version,
        draftCount: st.draftCount,
        draftId: st.draftId,
        simulationId: st.simulationId,
        verified: st.verified,
        verifiedMatched: st.verifiedMatched,
      };
    })
    .sort((a, b) => {
      const da = a.simulated != null ? a.simulated - a.baseline : -Infinity;
      const db = b.simulated != null ? b.simulated - b.baseline : -Infinity;
      return db - da;
    });

  // The CLIENT's latest done job. latestJobs[0] is NOT reliable here — the
  // DISTINCT ON ordering sorts competitor jobs first, and the classify
  // backfill button posts to /api/audit/[jobId]/classify with this id, so it
  // must be the client job (previously it was only used as a React key).
  const clientJobId = (latestJobs.find((j) => !j.competitor_id)?.id ?? latestJobs[0]?.id) as string;

  // Stale-baseline check: score rows produced before the determinism deploy
  // carry no content fingerprint (content_hash IS NULL). Optimizing against
  // them is apples-to-oranges — simulations run on the CURRENT engine — so we
  // surface a "re-run first" nudge until a fresh audit replaces them.
  let staleBaseline = false;
  if (clientJobId) {
    const staleRows = await sql`
      SELECT COUNT(*)::int AS n FROM page_scores
      WHERE job_id = ${clientJobId}
        AND content_hash IS NULL
        AND model_version <> 'error'
    `.catch(() => [] as Record<string, unknown>[]);
    staleBaseline = ((staleRows[0]?.n as number) ?? 0) > 0;
  }

  // Flattened competitor pages for the "Competitors outperforming you" card.
  const competitorPageEntries = project.competitors.flatMap((c) => {
    const cs = latestScoresMap[c.id] ?? [];
    return cs.map((p) => ({
      competitorName: c.name,
      color: COMPETITOR_COLORS[c.colorIndex],
      url: p.url,
      score: p.overallScore,
      grade: p.grade,
    }));
  });

  // Median letter grade across the client's audited pages.
  const clientMedianGrade = medianGrade(clientScores);

  // ── AI-crawler access (latest check for the client site) ──
  // Written by the run route at audit start; column is lazily created, so a
  // DB that has never run the new code just yields an empty result here.
  type AiAccessData = {
    checkedAt: string;
    origin: string;
    robotsFound: boolean;
    llmsTxtFound: boolean;
    bots: { name: string; status: "allowed" | "blocked" | "partial"; sampleRule: string | null }[];
  };
  const aiAccessRows = await sql`
    SELECT ai_access FROM audit_jobs
    WHERE project_id = ${params.id} AND competitor_id IS NULL AND ai_access IS NOT NULL
    ORDER BY created_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const aiAccess = (aiAccessRows[0]?.ai_access ?? null) as AiAccessData | null;
  const blockedBots = aiAccess?.bots.filter((b) => b.status === "blocked") ?? [];
  const partialBots = aiAccess?.bots.filter((b) => b.status === "partial") ?? [];

  // ── Search visibility (AIO/PAA) — latest client run with SERP data ──
  // Lazy tables: a DB that has never run SERP detection just yields null.
  // Stored data still renders even if the key was later removed.
  const serpEnabled = serpConfigured();
  let serpRollup = null as Awaited<ReturnType<typeof getSerpRollup>>;
  const serpJobId = await getLatestSerpJobId(params.id).catch(() => null);
  if (serpJobId) {
    serpRollup = await getSerpRollup(serpJobId).catch(() => null);
  }

  // ── Previous-run averages per site (for the matrix ▲/▼ tickers) ──
  // history is ordered ASC; the second-to-last point per site is "last run".
  const prevRuns: Record<string, { overall: number | null; dims: Partial<Record<keyof DimensionScores, number>> }> = {};
  {
    const siteKeys: (string | null)[] = [null, ...project.competitors.map((c) => c.id)];
    for (const key of siteKeys) {
      const pts = project.history.filter((h) => (h.competitorId ?? null) === key);
      if (pts.length < 2) continue;
      const prev = pts[pts.length - 2];
      prevRuns[key ?? "client"] = {
        overall: Math.round(Number(prev.avgScore)),
        dims: {
          coreIntent: Math.round(Number(prev.avgCoreIntent)),
          edgeCases: Math.round(Number(prev.avgEdgeCases)),
          impliedQuestions: Math.round(Number(prev.avgImpliedQuestions)),
          fanOutQueries: Math.round(Number(prev.avgFanOutQueries)),
          retrievable: Math.round(Number(prev.avgRetrievable)),
          extractable: Math.round(Number(prev.avgExtractable)),
          citable: Math.round(Number(prev.avgCitable)),
          reusable: Math.round(Number(prev.avgReusable)),
        },
      };
    }
  }

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
            {project.auditSource === "domain" && project.scopePrefix && (
              <span style={{ color: "var(--indigo)" }}>{project.scopePrefix}</span>
            )}
          </p>
          <div className="flex items-center gap-2 mt-2 flex-wrap">
            {project.auditSource !== "domain" && (
              <span
                className="inline-block px-2 py-0.5 rounded-md text-xs font-medium"
                style={{ background: "rgba(99,102,241,0.12)", color: "#4f46e5", border: "1px solid rgba(99,102,241,0.2)" }}
              >
                {project.auditSource === "single"
                  ? "Single page"
                  : `URL list · ${project.sourceUrls?.length ?? 0} page${(project.sourceUrls?.length ?? 0) !== 1 ? "s" : ""}`}
              </span>
            )}
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

        <div className="flex items-center gap-3">
          {project.latestScore != null && (
            <div className="text-center px-5 py-3 rounded-xl" style={{ background: "var(--bg-1)", border: "1px solid var(--border)" }}>
              <div className="text-3xl font-bold" style={{ color: scoreColor(project.latestScore) }}>
                {project.latestScore}
              </div>
              <div className="text-xs mt-0.5 flex items-center justify-center gap-1.5" style={{ color: "var(--text-3)" }}>
                Latest score
                <InfoTip
                  title="Latest score"
                  text="The average overall LLM-readiness score (0–100) across all pages in the latest completed audit run of this site."
                />
              </div>
            </div>
          )}
          {clientMedianGrade && (
            <div className="text-center px-5 py-3 rounded-xl" style={{ background: "var(--bg-1)", border: "1px solid var(--border)" }}>
              <div className="text-3xl font-bold" style={{ color: gradeColor(clientMedianGrade) }}>
                {clientMedianGrade}
              </div>
              <div className="text-xs mt-0.5 flex items-center justify-center gap-1.5" style={{ color: "var(--text-3)" }}>
                Median grade
                <InfoTip
                  title="Median grade"
                  text="The middle letter grade across all audited pages — a truer picture of the typical page than the average, since a few very strong or very weak pages can't skew it."
                />
              </div>
            </div>
          )}
          <div className="flex flex-col items-end gap-1.5">
            <RunButton projectId={params.id} hasCompetitors={project.competitors.length > 0} />
            {/* Download Assessment moved to the global top nav (see NavActions). */}
            {staleBaseline && !isRunning && (
              <p className="text-[10.5px] text-amber-600 text-right max-w-[200px] leading-snug">
                ⚠ Re-run before optimizing — current scores are from an older scoring engine
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Active run banner (live progress) ─────────────── */}
      {isRunning && (
        <LiveAuditBanner initialJobs={activeJobs as any} projectId={params.id} />
      )}

      {/* ── AI crawler access (robots.txt + llms.txt) ─────── */}
      {aiAccess && (
        <div
          className="anim-fade-up card p-5"
          style={
            blockedBots.length
              ? { border: "1px solid rgba(220,38,38,0.35)", background: "rgba(239,68,68,0.04)" }
              : partialBots.length
              ? { border: "1px solid rgba(217,119,6,0.35)", background: "rgba(245,158,11,0.04)" }
              : undefined
          }
        >
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="min-w-[240px]">
              <p className="section-label mb-1 flex items-center gap-1.5">
                AI Crawler Access
                <InfoTip
                  title="AI Crawler Access"
                  text="Checked from your site's robots.txt at the start of the last audit run: can the crawlers behind ChatGPT, Claude, Perplexity, and Google's AI training reach your pages? A blocked crawler cannot fetch your content at answer time — no content fix changes that until access is opened. llms.txt is an emerging standard file that gives AI systems a curated map of your site."
                />
              </p>
              <p className="text-sm" style={{ color: blockedBots.length ? "#dc2626" : "var(--text-2)" }}>
                {blockedBots.length ? (
                  <>
                    <span className="font-semibold">
                      Your site blocks {blockedBots.length} of {aiAccess.bots.length} AI crawlers
                    </span>{" "}
                    in robots.txt — those engines can&apos;t fetch your pages at all.
                  </>
                ) : partialBots.length ? (
                  <>
                    <span className="font-semibold" style={{ color: "#d97706" }}>
                      {partialBots.length} AI crawler{partialBots.length !== 1 ? "s are" : " is"} partially restricted
                    </span>{" "}
                    — some sections are invisible to those engines.
                  </>
                ) : (
                  <>All {aiAccess.bots.length} major AI crawlers can access your site.</>
                )}
                {!aiAccess.robotsFound && " (No robots.txt found — crawlers are allowed by default.)"}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {aiAccess.bots.map((b) => (
                <span
                  key={b.name}
                  title={b.sampleRule ? `robots.txt: ${b.sampleRule}` : `No restricting rule for ${b.name}`}
                  className="px-2.5 py-1 rounded-full text-xs font-semibold"
                  style={
                    b.status === "blocked"
                      ? { background: "rgba(239,68,68,0.12)", color: "#dc2626", border: "1px solid rgba(239,68,68,0.3)" }
                      : b.status === "partial"
                      ? { background: "rgba(245,158,11,0.12)", color: "#b45309", border: "1px solid rgba(245,158,11,0.3)" }
                      : { background: "rgba(16,185,129,0.10)", color: "#047857", border: "1px solid rgba(16,185,129,0.25)" }
                  }
                >
                  {b.name} {b.status === "blocked" ? "✕ blocked" : b.status === "partial" ? "◐ partial" : "✓"}
                </span>
              ))}
              <span
                className="px-2.5 py-1 rounded-full text-xs font-semibold"
                title={aiAccess.llmsTxtFound ? `${aiAccess.origin}/llms.txt exists` : "No llms.txt found — an emerging standard worth adding"}
                style={
                  aiAccess.llmsTxtFound
                    ? { background: "rgba(16,185,129,0.10)", color: "#047857", border: "1px solid rgba(16,185,129,0.25)" }
                    : { background: "var(--bg-2)", color: "var(--text-3)", border: "1px solid var(--border)" }
                }
              >
                llms.txt {aiAccess.llmsTxtFound ? "✓ present" : "— missing"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── Search visibility (AI Overviews + PAA) ────────── */}
      {hasResults && (
        <SearchVisibilityCard
          projectId={params.id}
          rollup={serpRollup}
          configured={serpEnabled}
        />
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
            projectId={params.id}
            prevRuns={prevRuns}
          />
        </div>
      )}

      {/* ── Optimized-pages summary (projected impact) ─────── */}
      {hasResults && optimizedRows.length > 0 && (
        <div className="anim-fade-up stagger-3">
          <p className="section-label">Optimization progress — projected impact</p>
          <OptimizedSummary projectId={params.id} rows={optimizedRows} />
        </div>
      )}

      {/* ── Full audit results (client) ────────────────────── */}
      {hasResults && (
        <div className="anim-fade-up stagger-3">
          <p className="section-label">{project.clientName} — page-level results</p>
          <AuditResults
            job={{ id: clientJobId } as any}
            scores={clientScores}
            summary={computeQuickSummary(clientScores)}
            competitorPages={competitorPageEntries}
            projectId={params.id}
            auditSource={project.auditSource}
            sourceUrls={project.sourceUrls}
            optimizeStates={optimizeStates}
          />
        </div>
      )}

      {/* Competitor management moved to the "Competitors" button in the top nav
          (see components/CompetitorManager.tsx). */}
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

function gradeColor(g: string) {
  return g === "A" ? "#059669" : g === "B" ? "#2563eb" : g === "C" ? "#d97706" : g === "D" ? "#ea580c" : "#dc2626";
}

function medianGrade(
  scores: Awaited<ReturnType<typeof getScoresByJob>>
): "A" | "B" | "C" | "D" | "F" | null {
  if (!scores.length) return null;
  const rank: Record<string, number> = { F: 0, D: 1, C: 2, B: 3, A: 4 };
  const letters = ["F", "D", "C", "B", "A"] as const;
  const sorted = scores.map((s) => rank[s.grade] ?? 0).sort((a, b) => a - b);
  return letters[sorted[Math.floor((sorted.length - 1) / 2)]];
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
