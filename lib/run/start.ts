// ─────────────────────────────────────────────────────────────
//  lib/run/start.ts — start a full project audit run.
//
//  Extracted VERBATIM from app/api/projects/[id]/run/route.ts so
//  the manual Run button and the scheduled-scan sweep share one
//  code path (same discovery, same job wiring, same competitor
//  handling) — a scheduled scan is exactly a pressed Run button.
//
//  The only addition: opts.onClientJobCreated fires as soon as the
//  client job row exists (before discovery), so the scheduler can
//  link its run row to the job BEFORE any status transition — the
//  finalize hook keys off that link.
// ─────────────────────────────────────────────────────────────

import { getProjectDetail } from "@/lib/db/projects";
import { createJob, updateJobStatus, setJobAiAccess } from "@/lib/db/client";
import { discoverUrls, probeSiteAccess } from "@/lib/crawler/discover";
import { checkAiCrawlerAccess } from "@/lib/crawler/ai-access";
import { enqueueCrawlBatches } from "@/lib/queue/qstash";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";

export interface StartRunResult {
  ok: boolean;
  status: number;
  error?: string;
  clientJobId?: string;
  jobs?: { type: "client" | "competitor"; id: string; competitorId?: string }[];
}

/** "https://www.chip.ca/foo" → "chip.ca" — for human-readable error text. */
function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Discovery came back empty. Say WHY, in words a user can act on.
 *
 * Before 2026-07-31 every empty result produced the same opaque line
 * ("No URLs discovered for client site") whether the site was empty or
 * hard-403ing the crawler, and the run route still returned 200 — so the
 * Run button flashed and the page came back unchanged. The phrase
 * "blocks automated crawling" is kept verbatim: other surfaces key off it.
 */
async function explainNoUrls(url: string, fromList: boolean): Promise<string> {
  if (fromList) return "No valid URLs in the uploaded list";
  const label = hostLabel(url);
  const probe = await probeSiteAccess(url).catch(() => null);
  if (probe?.blocked) {
    const code = probe.status ? `HTTP ${probe.status}` : "no response";
    return (
      `${label} blocks automated crawling (${code}). Every request for its ` +
      `sitemap and its homepage was refused, so no pages could be discovered. ` +
      `Ask the site owner to allow our crawler, or switch this project to a ` +
      `URL list you can supply directly.`
    );
  }
  const seen = probe?.status ? ` (homepage returned HTTP ${probe.status})` : "";
  return (
    `No URLs discovered for ${label}${seen} — no sitemap was found at the usual ` +
    `locations and no internal links were followed from the homepage.`
  );
}

export async function startProjectRun(
  projectId: string,
  opts: {
    includeCompetitors?: boolean;
    competitorIds?: string[];
    onClientJobCreated?: (jobId: string) => Promise<void>;
  } = {}
): Promise<StartRunResult> {
  const runCompetitors = opts.includeCompetitors ?? true;
  const competitorIds = opts.competitorIds;

  const project = await getProjectDetail(projectId);
  if (!project) {
    return { ok: false, status: 404, error: "Project not found" };
  }

  const sql = neon(process.env.DATABASE_URL!);

  // ── Cancel any existing stuck/active jobs before starting fresh ──
  await sql`
    UPDATE audit_jobs
    SET status = 'failed', error_message = 'Superseded by new run'
    WHERE project_id = ${projectId}
      AND status NOT IN ('done', 'failed')
  `.catch(() => null);

  const jobIds: { type: "client" | "competitor"; id: string; competitorId?: string }[] = [];

  // ── Run audit for client site ─────────────────────────────
  const clientJob = await createJob({
    url: project.websiteUrl,
    scopePrefix: project.scopePrefix ?? undefined,
    maxPages: project.maxPages,
    weights: { ...DEFAULT_WEIGHTS, ...project.weights } as DimensionScores,
  });

  await sql`
    UPDATE audit_jobs SET project_id = ${project.id}, competitor_id = NULL
    WHERE id = ${clientJob.id}
  `;

  // Link the scheduler's run row (if any) before ANY status transition.
  if (opts.onClientJobCreated) {
    await opts.onClientJobCreated(clientJob.id).catch(() => null);
  }

  // AI-crawler access check (robots.txt for GPTBot/ClaudeBot/PerplexityBot/
  // Google-Extended + llms.txt). Two quick GETs; best-effort — never blocks
  // the run.
  const clientAccess = await checkAiCrawlerAccess(project.websiteUrl).catch(() => null);
  if (clientAccess) {
    await setJobAiAccess(clientJob.id, clientAccess).catch(() => null);
  }

  // ── Build the client URL set by audit source ──────────────
  //   'single' → the one page (no discovery)
  //   'list'   → the explicit URL list (no discovery), capped by maxPages
  //   'domain' → discover the whole site (sitemap → BFS), as before
  let clientUrls: string[];
  if (project.auditSource === "single") {
    clientUrls = [project.websiteUrl];
  } else if (project.auditSource === "list") {
    clientUrls = Array.from(new Set(project.sourceUrls ?? [])).slice(0, project.maxPages);
  } else {
    await updateJobStatus(clientJob.id, "discovering");
    clientUrls = await discoverUrls({
      rootUrl: project.websiteUrl,
      scopePrefix: project.scopePrefix ?? undefined,
      maxPages: project.maxPages,
    });
  }

  // A zero-URL client run is a REAL failure and must be reported as one.
  // We still run the competitors below (their data is independently useful),
  // then return ok:false at the end carrying this message.
  let clientError: string | null = null;

  if (clientUrls.length > 0) {
    await updateJobStatus(clientJob.id, "crawling", { totalPages: clientUrls.length });
    await enqueueCrawlBatches(clientJob.id, clientUrls, null);
  } else {
    clientError = await explainNoUrls(project.websiteUrl, project.auditSource === "list");
    await updateJobStatus(clientJob.id, "failed", { errorMessage: clientError });
  }

  jobIds.push({ type: "client", id: clientJob.id });

  // ── Run audits for competitors ────────────────────────────
  if (runCompetitors && project.competitors.length > 0) {
    const toRun = competitorIds
      ? project.competitors.filter((c) => competitorIds.includes(c.id))
      : project.competitors;

    for (const competitor of toRun) {
      const compJob = await createJob({
        url: competitor.url,
        scopePrefix: competitor.scopePrefix ?? undefined,
        maxPages: Math.min(project.maxPages, 50),
        weights: { ...DEFAULT_WEIGHTS, ...project.weights } as DimensionScores,
      });

      await sql`
        UPDATE audit_jobs
        SET project_id = ${project.id}, competitor_id = ${competitor.id}
        WHERE id = ${compJob.id}
      `;

      const compAccess = await checkAiCrawlerAccess(competitor.url).catch(() => null);
      if (compAccess) {
        await setJobAiAccess(compJob.id, compAccess).catch(() => null);
      }

      await updateJobStatus(compJob.id, "discovering");
      const compUrls = await discoverUrls({
        rootUrl: competitor.url,
        scopePrefix: competitor.scopePrefix ?? undefined,
        maxPages: Math.min(project.maxPages, 50),
      });

      if (compUrls.length > 0) {
        await updateJobStatus(compJob.id, "crawling", { totalPages: compUrls.length });
        await enqueueCrawlBatches(compJob.id, compUrls, null);
      } else {
        await updateJobStatus(compJob.id, "failed", {
          errorMessage: await explainNoUrls(competitor.url, false),
        });
      }

      jobIds.push({ type: "competitor", id: compJob.id, competitorId: competitor.id });
    }
  }

  if (clientError) {
    return {
      ok: false,
      status: 502,
      error: clientError,
      clientJobId: clientJob.id,
      jobs: jobIds,
    };
  }

  return { ok: true, status: 200, clientJobId: clientJob.id, jobs: jobIds };
}
