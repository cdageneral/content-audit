// POST /api/projects/[id]/run
// Triggers a new audit run for the client site and optionally all competitors
import { NextRequest, NextResponse } from "next/server";
import { getProjectDetail } from "@/lib/db/projects";
import { createJob, updateJobStatus, setJobAiAccess } from "@/lib/db/client";
import { discoverUrls } from "@/lib/crawler/discover";
import { checkAiCrawlerAccess } from "@/lib/crawler/ai-access";
import { enqueueCrawlBatches } from "@/lib/queue/qstash";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const runCompetitors: boolean = body.includeCompetitors ?? true;
    const competitorIds: string[] | undefined = body.competitorIds;

    const project = await getProjectDetail(params.id);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const sql = neon(process.env.DATABASE_URL!);

    // ── Cancel any existing stuck/active jobs before starting fresh ──
    await sql`
      UPDATE audit_jobs
      SET status = 'failed', error_message = 'Superseded by new run'
      WHERE project_id = ${params.id}
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

    if (clientUrls.length > 0) {
      await updateJobStatus(clientJob.id, "crawling", { totalPages: clientUrls.length });
      await enqueueCrawlBatches(clientJob.id, clientUrls, null);
    } else {
      await updateJobStatus(clientJob.id, "failed", {
        errorMessage:
          project.auditSource === "list"
            ? "No valid URLs in the uploaded list"
            : "No URLs discovered for client site",
      });
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
            errorMessage: `No URLs discovered for ${competitor.name}`,
          });
        }

        jobIds.push({ type: "competitor", id: compJob.id, competitorId: competitor.id });
      }
    }

    return NextResponse.json({
      ok: true,
      jobs: jobIds,
      clientJobId: clientJob.id,
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/run]`, err);
    return NextResponse.json({ error: "Failed to start run" }, { status: 500 });
  }
}
