// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/serp
//  Manually (re)fetch SERP visibility (AIO/PAA) for the client's
//  latest completed audit run — lets existing projects get data
//  without a full re-crawl, and powers the hub card's button.
//
//  Idempotent + cheap: pages snapshotted for this job are skipped
//  by insertSnapshot's (page, job) guard, and same-month URLs are
//  served from the monthly cache at zero API-unit cost.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { checkProjectAccess } from "@/lib/auth/access";
import { serpConfigured } from "@/lib/serp/semrush";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import { dispatchSerpBatches } from "@/lib/serp/dispatch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    if (!serpConfigured() && !dfsConfigured()) {
      return NextResponse.json(
        {
          error:
            "Search visibility isn't configured yet — add DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD (or SEMRUSH_API_KEY) to enable AIO/PAA detection.",
        },
        { status: 501 }
      );
    }

    const sql = neon(process.env.DATABASE_URL!, {
      fetchOptions: { cache: "no-store" },
    });

    // Latest completed CLIENT run.
    const jobs = await sql`
      SELECT id FROM audit_jobs
      WHERE project_id = ${params.id} AND competitor_id IS NULL AND status = 'done'
      ORDER BY completed_at DESC NULLS LAST LIMIT 1
    `;
    const jobId = jobs[0]?.id as string | undefined;
    if (!jobId) {
      return NextResponse.json(
        { error: "No completed audit run yet — run an audit first." },
        { status: 409 }
      );
    }

    const pages = await sql`SELECT id FROM audit_pages WHERE job_id = ${jobId}`;
    if (pages.length === 0) {
      return NextResponse.json(
        { error: "The latest run has no crawled pages." },
        { status: 409 }
      );
    }

    const batches = await dispatchSerpBatches(
      jobId,
      params.id,
      pages.map((p) => p.id as string)
    );

    return NextResponse.json({
      ok: true,
      jobId,
      pages: pages.length,
      batches,
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/serp POST]`, err);
    return NextResponse.json(
      { error: "Failed to dispatch SERP fetch — please try again" },
      { status: 500 }
    );
  }
}
