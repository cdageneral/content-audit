/**
 * /api/admin/usage — super_admin only.
 *
 * GET   — the API-usage ledger rolled up for the admin panel:
 *          • summary (this month / last month / all time, tracking-since)
 *          • a project × provider matrix, from which the panel derives BOTH
 *            directions: per-project rollups (with a per-API split) and
 *            per-API rollups (with a per-project split)
 *          • per-run (audit job) rollups for the project drill-down
 *          • unassigned bucket (test calls + calls whose project was deleted)
 *         Every figure is emitted for three windows — all time, this month,
 *         last month — so the panel can rescope without a refetch.
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

/** One window's worth of usage for one cell of the matrix. */
interface Bucket {
  calls: number;
  costUsd: number;
  tokensIn: number;
  tokensOut: number;
  /** Calls that carry an exact cost. calls − pricedCalls = unpriced/not-billable-here. */
  pricedCalls: number;
}
const emptyBucket = (): Bucket => ({ calls: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, pricedCalls: 0 });
const addBucket = (a: Bucket, b: Bucket): Bucket => ({
  calls: a.calls + b.calls,
  costUsd: a.costUsd + b.costUsd,
  tokensIn: a.tokensIn + b.tokensIn,
  tokensOut: a.tokensOut + b.tokensOut,
  pricedCalls: a.pricedCalls + b.pricedCalls,
});
interface Windows { all: Bucket; month: Bucket; last: Bucket }
const emptyWindows = (): Windows => ({ all: emptyBucket(), month: emptyBucket(), last: emptyBucket() });
const addWindows = (a: Windows, b: Windows): Windows => ({
  all: addBucket(a.all, b.all),
  month: addBucket(a.month, b.month),
  last: addBucket(a.last, b.last),
});

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

    // ── Project × provider matrix ────────────────────────────
    // ONE grouped read is the source of truth for both the per-project and the
    // per-API views, so the two can never disagree. Project attribution: the
    // call's own project_id when recorded, else the project of the audit job it
    // belongs to. NULL pid = unassigned (diagnostics, or project/job deleted).
    const matrixRows = await sql`
      SELECT
        COALESCE(ac.project_id, j.project_id)                    AS pid,
        ac.provider                                              AS provider,
        COUNT(*)::int                                            AS calls,
        COALESCE(SUM(ac.cost_usd), 0)::float8                    AS cost,
        COALESCE(SUM(ac.input_tokens), 0)::float8                AS tokens_in,
        COALESCE(SUM(ac.output_tokens), 0)::float8               AS tokens_out,
        COUNT(*) FILTER (WHERE ac.cost_usd IS NOT NULL)::int      AS priced_calls,
        COUNT(*) FILTER (
          WHERE ac.created_at >= date_trunc('month', now())
        )::int                                                   AS m_calls,
        COALESCE(SUM(ac.cost_usd) FILTER (
          WHERE ac.created_at >= date_trunc('month', now())
        ), 0)::float8                                            AS m_cost,
        COALESCE(SUM(ac.input_tokens) FILTER (
          WHERE ac.created_at >= date_trunc('month', now())
        ), 0)::float8                                            AS m_in,
        COALESCE(SUM(ac.output_tokens) FILTER (
          WHERE ac.created_at >= date_trunc('month', now())
        ), 0)::float8                                            AS m_out,
        COUNT(*) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) AND ac.cost_usd IS NOT NULL
        )::int                                                   AS m_priced,
        COUNT(*) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
        )::int                                                   AS lm_calls,
        COALESCE(SUM(ac.cost_usd) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
        ), 0)::float8                                            AS lm_cost,
        COALESCE(SUM(ac.input_tokens) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
        ), 0)::float8                                            AS lm_in,
        COALESCE(SUM(ac.output_tokens) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
        ), 0)::float8                                            AS lm_out,
        COUNT(*) FILTER (
          WHERE ac.created_at >= date_trunc('month', now()) - INTERVAL '1 month'
            AND ac.created_at <  date_trunc('month', now())
            AND ac.cost_usd IS NOT NULL
        )::int                                                   AS lm_priced,
        MAX(ac.created_at)                                       AS last_at
      FROM api_calls ac
      LEFT JOIN audit_jobs j ON j.id = ac.job_id
      GROUP BY 1, 2
    `;

    interface Cell { pid: string | null; provider: string; windows: Windows; lastAt: string | null }
    const cells: Cell[] = matrixRows.map((r) => ({
      pid: (r.pid as string) ?? null,
      provider: r.provider as string,
      lastAt: (r.last_at as string) ?? null,
      windows: {
        all: {
          calls: num(r.calls), costUsd: num(r.cost),
          tokensIn: num(r.tokens_in), tokensOut: num(r.tokens_out),
          pricedCalls: num(r.priced_calls),
        },
        month: {
          calls: num(r.m_calls), costUsd: num(r.m_cost),
          tokensIn: num(r.m_in), tokensOut: num(r.m_out),
          pricedCalls: num(r.m_priced),
        },
        last: {
          calls: num(r.lm_calls), costUsd: num(r.lm_cost),
          tokensIn: num(r.lm_in), tokensOut: num(r.lm_out),
          pricedCalls: num(r.lm_priced),
        },
      },
    }));

    // Project names + budgets.
    // NOTE: the projects table's display column is `client_name` — an earlier
    // version of this route selected a non-existent `name` column, the whole
    // query failed, and EVERY project silently rendered as "Deleted project"
    // with no budget. The failure is now surfaced instead of swallowed.
    const metaState = { failed: false };
    const projMeta = await sql`
      SELECT id, client_name, monthly_budget_usd FROM projects
    `.catch((err) => {
      console.error("[api/admin/usage] project metadata read failed:", err);
      metaState.failed = true;
      return [] as Record<string, unknown>[];
    });
    const metaById = new Map(projMeta.map((p) => [p.id as string, p]));

    // ── Per-run rollup (project drill-down, level 2) ─────────
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

    // ── Fold the matrix into the two views ───────────────────
    // Per project (pid → totals + per-provider split)
    const projAcc = new Map<string, { windows: Windows; byProvider: Map<string, Windows>; lastAt: string | null }>();
    // Per provider (provider → totals + per-project split)
    const provAcc = new Map<string, { windows: Windows; byProject: Map<string, Windows> }>();
    const unassignedAcc = { windows: emptyWindows(), byProvider: new Map<string, Windows>() };

    for (const c of cells) {
      // provider side (includes unassigned spend — it is real money)
      const prov = provAcc.get(c.provider) ?? { windows: emptyWindows(), byProject: new Map<string, Windows>() };
      prov.windows = addWindows(prov.windows, c.windows);
      const projKey = c.pid ?? "__unassigned__";
      prov.byProject.set(projKey, addWindows(prov.byProject.get(projKey) ?? emptyWindows(), c.windows));
      provAcc.set(c.provider, prov);

      if (c.pid == null) {
        unassignedAcc.windows = addWindows(unassignedAcc.windows, c.windows);
        unassignedAcc.byProvider.set(
          c.provider,
          addWindows(unassignedAcc.byProvider.get(c.provider) ?? emptyWindows(), c.windows)
        );
        continue;
      }

      const proj = projAcc.get(c.pid) ?? { windows: emptyWindows(), byProvider: new Map<string, Windows>(), lastAt: null };
      proj.windows = addWindows(proj.windows, c.windows);
      proj.byProvider.set(c.provider, addWindows(proj.byProvider.get(c.provider) ?? emptyWindows(), c.windows));
      if (c.lastAt && (!proj.lastAt || c.lastAt > proj.lastAt)) proj.lastAt = c.lastAt;
      projAcc.set(c.pid, proj);
    }

    const providerSplit = (m: Map<string, Windows>) =>
      Array.from(m.entries())
        .map(([k, w]) => ({ provider: k, windows: w }))
        .sort((a, b) => b.windows.all.costUsd - a.windows.all.costUsd || b.windows.all.calls - a.windows.all.calls);

    const projects = Array.from(projAcc.entries())
      .map(([pid, acc]) => {
        const meta = metaById.get(pid);
        const runAgg = runAggByProject.get(pid);
        const budget =
          meta && meta.monthly_budget_usd != null ? Number(meta.monthly_budget_usd) : null;
        return {
          projectId: pid,
          name: (meta?.client_name as string) ?? null, // null → project no longer exists
          deleted: !meta,
          windows: acc.windows,
          byProvider: providerSplit(acc.byProvider),
          lastCallAt: acc.lastAt,
          budgetUsd: budget,
          // Budget is a MONTHLY figure, so it is always compared with this
          // month's spend regardless of the window the panel is showing.
          overBudget: budget != null && acc.windows.month.costUsd > budget,
          costPerPage:
            runAgg && runAgg.pages > 0
              ? Math.round((runAgg.cost / runAgg.pages) * 10000) / 10000
              : null,
          pagesScored: runAgg?.pages ?? 0,
        };
      })
      .sort((a, b) => b.windows.all.costUsd - a.windows.all.costUsd);

    const providers = Array.from(provAcc.entries())
      .map(([provider, acc]) => ({
        provider,
        windows: acc.windows,
        byProject: Array.from(acc.byProject.entries())
          .map(([pid, w]) => ({
            projectId: pid === "__unassigned__" ? null : pid,
            name:
              pid === "__unassigned__"
                ? null
                : ((metaById.get(pid)?.client_name as string) ?? null),
            deleted: pid !== "__unassigned__" && !metaById.get(pid),
            windows: w,
          }))
          .sort((a, b) => b.windows.all.costUsd - a.windows.all.costUsd || b.windows.all.calls - a.windows.all.calls),
      }))
      .sort((a, b) => b.windows.all.costUsd - a.windows.all.costUsd || b.windows.all.calls - a.windows.all.calls);

    return NextResponse.json({
      pricingAsOf: PRICING_ASOF,
      trackingSince: (s.first_at as string) ?? null,
      projectMetaUnavailable: metaState.failed,
      summary: {
        allTime: { calls: num(s.all_calls), costUsd: num(s.all_cost), tokensIn: num(s.all_in), tokensOut: num(s.all_out) },
        thisMonth: { calls: num(s.m_calls), costUsd: num(s.m_cost) },
        lastMonth: { calls: num(s.lm_calls), costUsd: num(s.lm_cost) },
        unpricedAnthropicCalls: num(s.unpriced_anthropic),
      },
      providers,
      projects,
      runs,
      unassigned: { windows: unassignedAcc.windows, byProvider: providerSplit(unassignedAcc.byProvider) },
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
