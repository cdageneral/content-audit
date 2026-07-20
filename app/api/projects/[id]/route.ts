import { NextRequest, NextResponse } from "next/server";
import { getProjectDetail, deleteProject, updateProjectSource } from "@/lib/db/projects";
import type { AuditSource } from "@/lib/db/projects";
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

// PATCH /api/projects/[id] — edit the audit source after creation.
// Body: { auditSource: 'domain'|'single'|'list', websiteUrl?, scopePrefix?,
//         maxPages?, sourceUrls? }.
// Only changes the project's configuration — existing runs/scores are kept;
// the next run builds its URL set from the updated source.
export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const auditSource = body.auditSource as AuditSource;
    if (!["domain", "single", "list"].includes(auditSource)) {
      return NextResponse.json(
        { error: "auditSource must be 'domain', 'single' or 'list'" },
        { status: 400 }
      );
    }

    const isValidHttpUrl = (u: unknown): u is string => {
      if (typeof u !== "string") return false;
      try {
        const p = new URL(u);
        return p.protocol === "http:" || p.protocol === "https:";
      } catch {
        return false;
      }
    };

    let websiteUrl: string;
    let sourceUrls: string[] | null = null;
    let scopePrefix: string | null = null;
    let maxPages: number;

    if (auditSource === "list") {
      const raw: unknown[] = Array.isArray(body.sourceUrls) ? body.sourceUrls : [];
      const urls = Array.from(new Set(raw.filter(isValidHttpUrl)));
      if (urls.length === 0) {
        return NextResponse.json(
          { error: "sourceUrls must contain at least one valid http(s) URL" },
          { status: 400 }
        );
      }
      sourceUrls = urls;
      // Same convention as project creation: the list's first URL is the
      // project's identity URL; cap max_pages to the list length.
      websiteUrl = urls[0];
      maxPages = Math.min(urls.length, 5000);
    } else {
      if (!isValidHttpUrl(body.websiteUrl)) {
        return NextResponse.json(
          { error: "websiteUrl must be a valid http(s) URL" },
          { status: 400 }
        );
      }
      websiteUrl = body.websiteUrl;
      if (auditSource === "single") {
        maxPages = 1;
      } else {
        scopePrefix =
          typeof body.scopePrefix === "string" && body.scopePrefix.trim()
            ? body.scopePrefix.trim()
            : null;
        const mp = Number(body.maxPages);
        maxPages =
          Number.isFinite(mp) && mp >= 1 ? Math.min(Math.round(mp), 5000) : 100;
      }
    }

    const project = await updateProjectSource(params.id, {
      auditSource,
      websiteUrl,
      scopePrefix,
      maxPages,
      sourceUrls,
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, project });
  } catch (err) {
    console.error(`[api/projects/${params.id} PATCH]`, err);
    return NextResponse.json(
      { error: "Failed to update audit source" },
      { status: 500 }
    );
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
