// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/volumes
//  Fetch verified per-keyword search volumes for the client's
//  latest completed run WITHOUT re-crawling or re-fetching SERPs.
//
//  Why it exists: the scan pipeline stores Google Ads volumes, which
//  report one cluster total shared by a keyword and all its close
//  variants — so the panel correctly refuses to show or sum them. The
//  volume sweep normally runs inside each SERP batch, which means a
//  project scanned before that shipped has no verified volume until its
//  next scan. This runs the same sweep on demand.
//
//  Cheap and idempotent: keywords already verified are skipped, and the
//  keyword_volumes cache means a keyword priced this month costs nothing
//  to re-read. Spend is capped by SERP_VOLUME_COST_CAP_USD.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { checkProjectAccess } from "@/lib/auth/access";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import { serpDefaultDatabase } from "@/lib/serp/semrush";
import { ensureSerpSchema } from "@/lib/db/serp";
import { sweepJobVolumes } from "@/lib/serp/volumes";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Params = { params: { id: string } };

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (!dfsConfigured()) {
      return NextResponse.json(
        {
          error:
            "Per-keyword search volume needs DataForSEO — add DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD.",
        },
        { status: 501 }
      );
    }

    await ensureSerpSchema();
    const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });

    // Latest client run that actually has SERP snapshots — the same scan the
    // Rankings panel reads, so the numbers land where the user is looking.
    const jobs = await sql`
      SELECT s.job_id, MAX(s.fetched_at) AS fetched_at
      FROM serp_snapshots s
      JOIN audit_jobs j ON j.id = s.job_id
      WHERE s.project_id = ${params.id} AND j.competitor_id IS NULL
      GROUP BY s.job_id
      ORDER BY MAX(s.fetched_at) DESC
      LIMIT 1
    `;
    const jobId = jobs[0]?.job_id as string | undefined;
    if (!jobId) {
      return NextResponse.json(
        { error: "No scan with SERP data yet — run an audit first." },
        { status: 409 }
      );
    }

    const proj = await sql`SELECT serp_database FROM projects WHERE id = ${params.id}`;
    const database = (proj[0]?.serp_database as string) || serpDefaultDatabase();

    const result = await sweepJobVolumes(jobId, database);

    return NextResponse.json({
      ok: true,
      jobId,
      database,
      ...result,
      // Surfaced so the UI can say what was actually achieved rather than
      // implying full coverage.
      message:
        result.rowsUpdated > 0
          ? `Verified volume for ${result.rowsUpdated} keyword row(s)` +
            (result.cappedOut ? " — spend cap reached, run again to continue." : ".")
          : "No new volumes were available for this scan's keywords.",
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/volumes POST]`, err);
    return NextResponse.json(
      { error: "Failed to fetch search volumes — please try again" },
      { status: 500 }
    );
  }
}
