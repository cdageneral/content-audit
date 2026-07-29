// ─────────────────────────────────────────────────────────────
//  /api/cron/scheduled-scans — the daily sweep.
//
//  ONE Vercel Cron entry (vercel.json) fires this once a day at
//  09:00 UTC (overnight Pacific). The DB is the single source of
//  truth: every enabled scan_schedules row with next_run_at in the
//  past is claimed (next_run_at atomically advanced — double fires
//  are no-ops) and kicked through the EXACT same run pipeline as
//  the manual Run button (lib/run/start.ts).
//
//  Skip rules (recorded as honest history rows, never silent):
//   • an audit is already in progress for the project
//   • a manual scan ran within the last MANUAL_SKIP_HOURS
//
//  Auth: when CRON_SECRET is set (Vercel sends it as a Bearer
//  token on cron invocations) it is required. Without the env the
//  route stays safe anyway — claiming is idempotent, so hitting it
//  repeatedly does nothing beyond what the schedule already allows.
// ─────────────────────────────────────────────────────────────

export const maxDuration = 300;
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  attachJobToScanRun,
  claimDueSchedule,
  closeStaleScanRuns,
  insertScanRun,
  listDueSchedules,
} from "@/lib/schedule/store";
import { MANUAL_SKIP_HOURS } from "@/lib/schedule/types";
import { startProjectRun } from "@/lib/run/start";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

async function handleSweep(req: NextRequest): Promise<NextResponse> {
  // Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` when the env
  // var exists. Enforce it when configured; note it when not.
  if (process.env.CRON_SECRET) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const sql = db();
  const now = new Date();
  const results: Record<string, string> = {};

  const staleClosed = await closeStaleScanRuns().catch(() => 0);

  const due = await listDueSchedules(now);
  for (const schedule of due) {
    const pid = schedule.projectId;
    try {
      // Atomic claim — advances next_run_at so a concurrent/repeat sweep
      // (or a manual re-hit of this route) can't double-start anything.
      const claimed = await claimDueSchedule(schedule, now);
      if (!claimed) {
        results[pid] = "already claimed";
        continue;
      }

      // Skip: an audit is already running for this project.
      const active = await sql`
        SELECT id FROM audit_jobs
        WHERE project_id = ${pid} AND status NOT IN ('done', 'failed')
        LIMIT 1
      `;
      if (active.length > 0) {
        await insertScanRun({
          projectId: pid,
          status: "skipped",
          note: "An audit was already in progress",
        });
        results[pid] = "skipped: audit in progress";
        continue;
      }

      // Skip: a manual scan already ran inside the window — no double spend.
      const recent = await sql`
        SELECT id, created_at FROM audit_jobs
        WHERE project_id = ${pid}
          AND competitor_id IS NULL
          AND status = 'done'
          AND created_at > NOW() - make_interval(hours => ${MANUAL_SKIP_HOURS})
        ORDER BY created_at DESC
        LIMIT 1
      `;
      if (recent.length > 0) {
        const when = new Date(recent[0].created_at as string)
          .toISOString()
          .slice(0, 10);
        await insertScanRun({
          projectId: pid,
          status: "skipped",
          note: `A scan already ran on ${when} — within the ${MANUAL_SKIP_HOURS}h window`,
        });
        results[pid] = "skipped: recent scan";
        continue;
      }

      // Kick the run through the shared pipeline. The run row is linked to
      // the client job the moment it exists (before discovery), so the
      // finalize hook catches every terminal path, including instant fails.
      const runId = await insertScanRun({ projectId: pid, status: "running" });
      const result = await startProjectRun(pid, {
        includeCompetitors: true,
        onClientJobCreated: (jobId) => attachJobToScanRun(runId, jobId),
      });

      if (!result.ok) {
        const { finalizeScanRun, recordScheduleFailure } = await import(
          "@/lib/schedule/store"
        );
        await recordScheduleFailure(pid, result.error ?? "Failed to start run");
        await finalizeScanRun(runId, {
          status: "failed",
          note: result.error ?? "Failed to start run",
        });
        results[pid] = `failed to start: ${result.error}`;
        continue;
      }

      results[pid] = `started job ${result.clientJobId}`;
      console.log(`[cron/scans] Project ${pid}: started job ${result.clientJobId}`);
    } catch (err) {
      // One project's failure must never stop the rest of the sweep.
      console.error(`[cron/scans] Project ${pid} sweep error:`, err);
      results[pid] = `error: ${String(err)}`.slice(0, 200);
    }
  }

  return NextResponse.json({
    ok: true,
    at: now.toISOString(),
    due: due.length,
    staleClosed,
    results,
  });
}

// Vercel Cron invokes with GET; keep POST for manual/queued triggering.
export async function GET(req: NextRequest) {
  return handleSweep(req);
}
export async function POST(req: NextRequest) {
  return handleSweep(req);
}
