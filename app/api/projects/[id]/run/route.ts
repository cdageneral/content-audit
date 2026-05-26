// POST /api/projects/[id]/run
// Triggers a new audit run for the client site and optionally all competitors
import { NextRequest, NextResponse } from "next/server";
import { getProjectDetail } from "@/lib/db/projects";
import { createJob, updateJobStatus } from "@/lib/db/client";
import { discoverUrls } from "@/lib/crawler/discover";
import { enqueueCrawlBatches } from "@/lib/queue/qstash";
import { neon } from "@neondatabase/serverless";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const runCompetitors: boolean = body.includeCompetitors ?? true;
    const competitorIds: string[] | undefined = body.competitorIds; // run specific competitors only

    const project = await getProjectDetail(params.id);
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const sql = neon(process.env.DATABASE_URL!);
    const jobIds: { type: "client" | "competitor"; id: string; competitorId?: string }[] = [];

    // ── Run audit for client site ─────────────────────────────
    const clientJob = await createJob({
      url: project.websiteUrl,
      scopePrefix: project.scopePrefix ?? undefined,
      maxPages: project.maxPages,
      weights: { ...DEFAULT_WEIGHTS, ...project.weights } as DimensionScores,
    });

    // Link job to project
    await sql`
      UPDATE audit_jobs SET project_id = ${project.id}, competitor_id = NULL
      WHERE id = ${clientJob.id}
    `;

    await updateJobStatus(clientJob.id, "discovering");
    const clientUrls = await discoverUrls({
      rootUrl: project.websiteUrl,
      scopePrefix: project.scopePrefix ?? undefined,
      maxPages: project.maxPages,
    });

    if (clientUrls.length > 0) {
      await updateJobStatus(clientJob.id, "crawling", { totalPages: clientUrls.length });
      await enqueueCrawlBatches(clientJob.id, clientUrls, null);
    } else {
      await updateJobStatus(clientJob.id, "failed", {
        errorMessage: "No URLs discovered for client site",
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
          maxPages: Math.min(project.maxPages, 50), // limit competitor crawl depth
          weights: { ...DEFAULT_WEIGHTS, ...project.weights } as DimensionScores,
        });

        await sql`
          UPDATE audit_jobs
          SET project_id = ${project.id}, competitor_id = ${competitor.id}
          WHERE id = ${compJob.id}
        `;

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
