/**
 * /api/admin/usage/calls — super_admin only. The individual-call log
 * (drill-down level 3): every recorded API call with its timestamp, purpose,
 * model, exact token counts, and exact cost.
 *
 * Filters (exactly one):
 *   ?jobId=<uuid>        — calls belonging to one audit run
 *   ?projectId=<uuid>    — calls attributed to one project (direct or via job)
 *   ?scope=unassigned    — calls with no resolvable project (tests, deleted)
 * Paging: ?limit= (max 500, default 200) & ?offset=
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { checkSuperAdmin } from "@/lib/auth/access";
import { ensureUsageSchema } from "@/lib/usage/record";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

export async function GET(req: NextRequest) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  try {
    await ensureUsageSchema();
    const sql = db();
    const sp = req.nextUrl.searchParams;
    const jobId = sp.get("jobId");
    const projectId = sp.get("projectId");
    const scope = sp.get("scope");
    const limit = Math.min(500, Math.max(1, parseInt(sp.get("limit") ?? "200", 10) || 200));
    const offset = Math.max(0, parseInt(sp.get("offset") ?? "0", 10) || 0);

    let rows;
    if (jobId && UUID_RE.test(jobId)) {
      rows = await sql`
        SELECT ac.id, ac.created_at, ac.provider, ac.purpose, ac.model,
               ac.input_tokens, ac.output_tokens, ac.cost_usd, ac.page_url, ac.meta
        FROM api_calls ac
        WHERE ac.job_id = ${jobId}
        ORDER BY ac.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (projectId && UUID_RE.test(projectId)) {
      rows = await sql`
        SELECT ac.id, ac.created_at, ac.provider, ac.purpose, ac.model,
               ac.input_tokens, ac.output_tokens, ac.cost_usd, ac.page_url, ac.meta
        FROM api_calls ac
        LEFT JOIN audit_jobs j ON j.id = ac.job_id
        WHERE COALESCE(ac.project_id, j.project_id) = ${projectId}
        ORDER BY ac.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (scope === "unassigned") {
      rows = await sql`
        SELECT ac.id, ac.created_at, ac.provider, ac.purpose, ac.model,
               ac.input_tokens, ac.output_tokens, ac.cost_usd, ac.page_url, ac.meta
        FROM api_calls ac
        LEFT JOIN audit_jobs j ON j.id = ac.job_id
        WHERE COALESCE(ac.project_id, j.project_id) IS NULL
        ORDER BY ac.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      return NextResponse.json(
        { error: "Provide jobId, projectId, or scope=unassigned" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      calls: rows.map((r) => ({
        id: r.id as string,
        createdAt: r.created_at as string,
        provider: r.provider as string,
        purpose: r.purpose as string,
        model: (r.model as string) ?? null,
        inputTokens: r.input_tokens == null ? null : Number(r.input_tokens),
        outputTokens: r.output_tokens == null ? null : Number(r.output_tokens),
        costUsd: r.cost_usd == null ? null : Number(r.cost_usd),
        pageUrl: (r.page_url as string) ?? null,
        meta: (r.meta as Record<string, unknown>) ?? {},
      })),
      limit,
      offset,
    });
  } catch (err) {
    console.error("[api/admin/usage/calls GET]", err);
    return NextResponse.json({ error: "Failed to load calls" }, { status: 500 });
  }
}
