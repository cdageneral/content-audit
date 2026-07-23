/**
 * /api/admin/usage — super_admin only.
 *
 * GET   — the API-usage ledger rolled up for the admin panel:
 *          • summary (this month / last month / all time, tracking-since)
 *          • per-provider breakdown
 *          • per-project rollups (cost, tokens, budget, cost-per-page)
 *          • per-run (audit job) rollups for the project drill-down
 *          • unassigned bucket (test calls + calls whose project was deleted)
 *         Every number is an aggregate of REAL recorded calls — rows exist
 *         only from the moment usage tracking shipped; there is no historical
 *         reconstruction and no estimation.
 * PATCH — set/clear a project's monthly budget (monthly_budget_usd).
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import { checkSuperAdmin } from "@/lib/auth/access";
import { ensureUsageSchema } from "@/lib/usage/record";
import { PRICING_ASOF } from "@/lib/usage/pricing";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

export async function GET() {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  try {
    await ensureUsageSchema();
    const sql = db();

    // ── Overall summary ──────────────────────────────────────
    const summaryRows = await sql`
      SELECT
        COUNT(*)::int                                            AS all_calls,
        COALESCE(SUM(cost_usd), 0)::float8                       AS all_cost,
        COALESCE(SUM(input_tokens), 0)::float8                   AS all_in,
        COALESCE(SUM(output_tokens), 0)::float8                  AS all_out,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('month', now())
        )::int                                                   AS m_calls,
        COALESCE(SUM(cost_usd) FILTER (
          WHERE created_at >= date_trunc('month', now())
        ), 0)::float8                                            AS m_cost,
        COUNT(*) FILTER (
          WHERE created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND created_at <  date_trunc('month', now())
        )::int                                                   AS lm_calls,
        COALESCE(SUM(cost_usd) FILTER (
          WHERE created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND created_at <  date_trunc('month', now())
        ), 0)::float8                                            AS lm_cost,
        COUNT(*) FILTER (
          WHERE cost_usd IS NULL AND provider = 'anthropic'
        )::int                                                   AS unpriced_anthropic,
        MIN(created_at)                                          AS first_at
      FROM api_calls
    `;
    const s = summaryRows[0] ?? {};

    // ── Per-provider breakdown ───────────────────────────────
    const providerRows = await sql`
      SELECT provider,
             COUNT(*)::int                          AS calls,
             COALESCE(SUM(cost_usd), 0)::float8     AS cost,
             COUNT(*) FILTER (WHERE cost_usd IS NOT NULL)::int AS priced_calls,
             COALESCE(SUM(input_tokens), 0)::float8 AS tokens_in,
             COALESCE(SUM(output_tokens), 0)::float8 AS tokens_out
      FROM api_calls
      GROUP BY provider
      ORDER BY cost DESC, calls DESC
    `;

    // ── Per-project rollup ───────────────────────────────────
    // Project attribution: the call's own project_id when recorded, else the
    // project of the audit job it belongs to. NULL = unassigned (test calls,
    // or the project/job has since been deleted).
    const projectRows = await sql`
      SELECT
        COALESCE(ac.project_id, j.project_id)                    AS pid,
        COUNT(*)::int                                            AS calls,
        COALESCE(SUM(ac.cost_usd), 0)::float8                    AS cost,
        COALESCE(SUM(ac.input_tokens), 0)::float8                AS tokens_in,
        COALESCE(SUM(ac.output_tokens), 0)::float8               AS tokens_out,
        COALESCE(SUM(ac.cost_usd) FILTER (
          WHERE ac.created_at >= date_trunc('month', now())
        ), 0)::float8                                            AS m_cost,
        COALESCE(SUM(ac.cost_usd) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
        ), 0)::float8                                            AS lm_cost,
        MAX(ac.created_at)                                       AS last_at
      FROM api_calls ac
      LEFT JOIN audit_jobs j ON j.id = ac.job_id
      GROUP BY 1
    `;

    // Project names + budgets (budget column ensured by ensureUsageSchema).
    const projMeta = await sql`
      SELECT id, name, monthly_budget_usd FROM projects
    `.catch(() => [] as Record<string, unknown>[]);
    const metaById = new Map(
      projMeta.map((p) => [p.id as string, p])
    );

    // ── Per-run rollup (drill-down level 2) ──────────────────
    const runRows = await sql`
      SELECT
        ac.job_id                                                AS job_id,
        COALESCE(ac.project_id, j.project_id)                    AS pid,
        COUNT(*)::int                                            AS calls,
        COALESCE(SUM(ac.cost_usd), 0)::float8                    AS cost,
        COALESCE(SUM(ac.input_tokens), 0)::float8                AS tokens_in,
        COALESCE(SUM(ac.output_tokens), 0)::float8               AS tokens_out,
        MIN(ac.created_at)                                       AS first_at,
        MAX(ac.created_at)                                       AS last_at,
        MAX(j.url)                                               AS job_url,
        MAX(j.status)                                            AS job_status,
        MAX(j.scored_pages)::int                                 AS pages_scored
      FROM api_calls ac
      LEFT JOIN audit_jobs j ON j.id = ac.job_id
      WHERE ac.job_id IS NOT NULL
      GROUP BY ac.job_id, COALESCE(ac.project_id, j.project_id)
      ORDER BY MIN(ac.created_at) DESC
      LIMIT 300
    `;

    const runs = runRows.map((r) => ({
      jobId: r.job_id as string,
      projectId: (r.pid as string) ?? null,
      calls: num(r.calls),
      costUsd: num(r.cost),
      tokensIn: num(r.tokens_in),
      tokensOut: num(r.tokens_out),
      firstAt: r.first_at as string,
      lastAt: r.last_at as string,
      jobUrl: (r.job_url as string) ?? null,
      jobStatus: (r.job_status as string) ?? null,
      pagesScored: r.pages_scored == null ? null : num(r.pages_scored),
    }));

    // Cost-per-page per project: audit-run spend ÷ pages actually scored in
    // those runs (both real recorded figures; null when no scored pages).
    const runAggByProject = new Map<string, { cost: number; pages: number }>();
    for (const r of runs) {
      if (!r.projectId) continue;
      const agg = runAggByProject.get(r.projectId) ?? { cost: 0, pages: 0 };
      agg.cost += r.costUsd;
      agg.pages += r.pagesScored ?? 0;
      runAggByProject.set(r.projectId, agg);
    }

    const projects = projectRows
      .filter((p) => p.pid != null)
      .map((p) => {
        const pid = p.pid as string;
        const meta = metaById.get(pid);
        const runAgg = runAggByProject.get(pid);
        const budget =
          meta && meta.monthly_budget_usd != null
            ? Number(meta.monthly_budget_usd)
            : null;
        const mCost = num(p.m_cost);
        return {
          projectId: pid,
          name: (meta?.name as string) ?? null, // null → deleted project
          deleted: !meta,
          calls: num(p.calls),
          costUsd: num(p.cost),
          tokensIn: num(p.tokens_in),
          tokensOut: num(p.tokens_out),
          thisMonthCost: mCost,
          lastMonthCost: num(p.lm_cost),
          lastCallAt: p.last_at as string,
          budgetUsd: budget,
          overBudget: budget != null && mCost > budget,
          costPerPage:
            runAgg && runAgg.pages > 0
              ? Math.round((runAgg.cost / runAgg.pages) * 10000) / 10000
              : null,
          pagesScored: runAgg?.pages ?? 0,
        };
      })
      .sort((a, b) => b.costUsd - a.costUsd);

    const unassignedRow = projectRows.find((p) => p.pid == null);
    const unassigned = unassignedRow
      ? {
          calls: num(unassignedRow.calls),
          costUsd: num(unassignedRow.cost),
          tokensIn: num(unassignedRow.tokens_in),
          tokensOut: num(unassignedRow.tokens_out),
        }
      : { calls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0 };

    return NextResponse.json({
      pricingAsOf: PRICING_ASOF,
      trackingSince: (s.first_at as string) ?? null,
      summary: {
        allTime: { calls: num(s.all_calls), costUsd: num(s.all_cost), tokensIn: num(s.all_in), tokensOut: num(s.all_out) },
        thisMonth: { calls: num(s.m_calls), costUsd: num(s.m_cost) },
        lastMonth: { calls: num(s.lm_calls), costUsd: num(s.lm_cost) },
        unpricedAnthropicCalls: num(s.unpriced_anthropic),
      },
      providers: providerRows.map((r) => ({
        provider: r.provider as string,
        calls: num(r.calls),
        costUsd: num(r.cost),
        pricedCalls: num(r.priced_calls),
        tokensIn: num(r.tokens_in),
        tokensOut: num(r.tokens_out),
      })),
      projects,
      runs,
      unassigned,
    });
  } catch (err) {
    console.error("[api/admin/usage GET]", err);
    return NextResponse.json({ error: "Failed to load usage" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

  try {
    const body = await req.json().catch(() => ({}));
    const projectId = body?.projectId as string | undefined;
    const raw = body?.monthlyBudgetUsd;

    if (!projectId || !/^[0-9a-f-]{36}$/i.test(projectId)) {
      return NextResponse.json({ error: "projectId required" }, { status: 400 });
    }
    let budget: number | null = null;
    if (raw !== null && raw !== undefined && raw !== "") {
      budget = Number(raw);
      if (!isFinite(budget) || budget < 0 || budget > 1_000_000) {
        return NextResponse.json({ error: "Invalid budget" }, { status: 400 });
      }
      budget = Math.round(budget * 100) / 100;
    }

    await ensureUsageSchema();
    const sql = db();
    const rows = await sql`
      UPDATE projects SET monthly_budget_usd = ${budget}
      WHERE id = ${projectId}
      RETURNING id
    `;
    if (!rows.length) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, projectId, monthlyBudgetUsd: budget });
  } catch (err) {
    console.error("[api/admin/usage PATCH]", err);
    return NextResponse.json({ error: "Failed to update budget" }, { status: 500 });
  }
}
