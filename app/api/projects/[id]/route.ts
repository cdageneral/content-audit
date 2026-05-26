import { NextRequest, NextResponse } from "next/server";
import { getProjectDetail, deleteProject } from "@/lib/db/projects";
import { getScoresByJob } from "@/lib/db/client";

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const detail = await getProjectDetail(params.id);
    if (!detail) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Get latest scores for client site and each competitor
    const { getJob } = await import("@/lib/db/client");
    const neon = (await import("@neondatabase/serverless")).neon;
    const sql = neon(process.env.DATABASE_URL!);

    // Latest completed job per tracked site
    const latestJobs = await sql`
      SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
        id, competitor_id, status, completed_at
      FROM audit_jobs
      WHERE project_id = ${params.id} AND status = 'done'
      ORDER BY COALESCE(competitor_id::text, 'client'), completed_at DESC
    `;

    const latestScores: Record<string, unknown> = {};
    for (const job of latestJobs) {
      const scores = await getScoresByJob(job.id as string);
      const key = job.competitor_id ? String(job.competitor_id) : "client";
      latestScores[key] = scores;
    }

    return NextResponse.json({ project: detail, latestScores });
  } catch (err) {
    console.error(`[api/projects/${params.id} GET]`, err);
    return NextResponse.json({ error: "Failed to load project" }, { status: 500 });
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    await deleteProject(params.id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[api/projects/${params.id} DELETE]`, err);
    return NextResponse.json({ error: "Failed to delete project" }, { status: 500 });
  }
}
