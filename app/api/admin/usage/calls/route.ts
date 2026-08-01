/**
 * /api/admin/usage/calls — super_admin only. The individual-call log
 * (deepest drill-down): every recorded API call with its timestamp, purpose,
 * model, exact token counts, and exact cost.
 *
 * Scope (exactly one):
 *   ?jobId=<uuid>        — calls belonging to one audit run
 *   ?projectId=<uuid>    — calls attributed to one project (direct or via job)
 *   ?scope=unassigned    — calls with no resolvable project (tests, deleted)
 * Optional filters (combine with any scope):
 *   ?provider=<name>     — one API provider (anthropic | dataforseo | …)
 *   ?window=month|last   — this calendar month | last calendar month
 *                          (omitted or 'all' = no time filter). The month
 *                          boundaries are computed in SQL with the SAME
 *                          date_trunc expressions the rollups use, so a call
 *                          log can never disagree with the totals above it.
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
const PROVIDER_RE = /^[a-z0-9_-]{1,40}$/i;

export async function GET(req: NextRequest) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  try {
    await ensureUsageSchema();
    const sql = db();
    const sp = req.nextUrl.searchParams;

    const jobIdRaw = sp.get("jobId");
    const projectIdRaw = sp.get("projectId");
    const scope = sp.get("scope");
    const providerRaw = sp.get("provider");
    const windowRaw = sp.get("window");

    const jobId = jobIdRaw && UUID_RE.test(jobIdRaw) ? jobIdRaw : null;
    const projectId = projectIdRaw && UUID_RE.test(projectIdRaw) ? projectIdRaw : null;
    const unassigned = scope === "unassigned";
    const provider = providerRaw && PROVIDER_RE.test(providerRaw) ? providerRaw : null;
    const win = windowRaw === "month" || windowRaw === "last" ? windowRaw : "all";

    if (!jobId && !projectId && !unassigned) {
      return NextResponse.json(
        { error: "Provide jobId, projectId, or scope=unassigned" },
        { status: 400 }
      );
    }

    const limit = Math.min(500, Math.max(1, parseInt(sp.get("limit") ?? "200", 10) || 200));
    const offset = Math.max(0, parseInt(sp.get("offset") ?? "0", 10) || 0);

    // Single parameterised statement — the Neon tagged template can't compose
    // SQL fragments, so the scope/filter switches ride in as bound values.
    const rows = await sql`
      SELECT ac.id, ac.created_at, ac.provider, ac.purpose, ac.model,
             ac.input_tokens, ac.output_tokens, ac.cost_usd, ac.page_url, ac.meta
      FROM api_calls ac
      LEFT JOIN audit_jobs j ON j.id = ac.job_id
      WHERE (
              (${jobId}::uuid     IS NOT NULL AND ac.job_id = ${jobId}::uuid)
           OR (${projectId}::uuid IS NOT NULL AND COALESCE(ac.project_id, j.project_id) = ${projectId}::uuid)
           OR (${unassigned}::boolean          AND COALESCE(ac.project_id, j.project_id) IS NULL)
            )
        AND (${provider}::text IS NULL OR ac.provider = ${provider}::text)
        AND (
              ${win}::text = 'all'
           OR (${win}::text = 'month'
               AND ac.created_at >= date_trunc('month', now()))
           OR (${win}::text = 'last'
               AND ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
               AND ac.created_at <  date_trunc('month', now()))
            )
      ORDER BY ac.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

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
