// ─────────────────────────────────────────────────────────────
//  lib/schedule/store.ts — Scan Schedule persistence (server-only).
//
//  scan_schedules:     one row per project — the cadence config.
//  scan_schedule_runs: one row per scheduled attempt (completed,
//                      failed, or skipped-with-reason), so the page
//                      can show an honest history of what actually
//                      happened, including runs that never started.
//
//  Same lazy idempotent-DDL pattern as lib/brand/store.ts, the same
//  mandatory Neon no-store option, and the same delete+insert save
//  (no ON CONFLICT — see the upsertScore 42P10 postmortem).
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import {
  computeNextRunAt,
  sanitizeScanSchedule,
  AUTO_PAUSE_AFTER,
  type ScanRun,
  type ScanRunStatus,
  type ScanRunSummary,
  type ScanSchedule,
} from "./types";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let scheduleSchemaReady: Promise<void> | null = null;

export function ensureScheduleSchema(): Promise<void> {
  if (!scheduleSchemaReady) {
    scheduleSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS scan_schedules (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id            UUID NOT NULL UNIQUE,
          enabled               BOOLEAN NOT NULL DEFAULT FALSE,
          cadence               TEXT NOT NULL DEFAULT 'twice_monthly',
          day_of_week           INTEGER NOT NULL DEFAULT 4,
          day_of_month          INTEGER NOT NULL DEFAULT 1,
          email_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
          recipients            JSONB NOT NULL DEFAULT '[]',
          send_mode             TEXT NOT NULL DEFAULT 'always',
          next_run_at           TIMESTAMPTZ,
          last_run_at           TIMESTAMPTZ,
          consecutive_failures  INTEGER NOT NULL DEFAULT 0,
          paused_reason         TEXT,
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS scan_schedule_runs (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id   UUID NOT NULL,
          schedule_id  UUID,
          job_id       UUID,
          status       TEXT NOT NULL DEFAULT 'running',
          note         TEXT,
          summary      JSONB,
          email_status TEXT,
          started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at  TIMESTAMPTZ
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_scan_runs_project
        ON scan_schedule_runs(project_id, started_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_scan_runs_job
        ON scan_schedule_runs(job_id)
      `;
    })().catch((err) => {
      scheduleSchemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return scheduleSchemaReady;
}

function rowToSchedule(r: Record<string, unknown>): ScanSchedule {
  return sanitizeScanSchedule(
    {
      enabled: r.enabled === true,
      cadence: r.cadence,
      dayOfWeek: r.day_of_week,
      dayOfMonth: r.day_of_month,
      emailEnabled: r.email_enabled === true,
      recipients: r.recipients,
      sendMode: r.send_mode,
      nextRunAt: r.next_run_at ? new Date(r.next_run_at as string).toISOString() : null,
      lastRunAt: r.last_run_at ? new Date(r.last_run_at as string).toISOString() : null,
      consecutiveFailures: r.consecutive_failures,
      pausedReason: r.paused_reason,
      updatedAt: r.updated_at ? new Date(r.updated_at as string).toISOString() : null,
    },
    String(r.project_id)
  );
}

export async function getScanSchedule(
  projectId: string
): Promise<ScanSchedule | null> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM scan_schedules WHERE project_id = ${projectId}
  `;
  return rows[0] ? rowToSchedule(rows[0]) : null;
}

/**
 * Save the user-editable config. Server owns the derived fields:
 * next_run_at is recomputed here, and re-enabling always clears the
 * auto-pause state (failure count + reason).
 */
export async function saveScanSchedule(
  projectId: string,
  input: unknown
): Promise<ScanSchedule> {
  await ensureScheduleSchema();
  const sql = db();
  const clean = sanitizeScanSchedule(input, projectId);
  const nextRunAt = clean.enabled
    ? computeNextRunAt(clean.cadence, clean.dayOfWeek, clean.dayOfMonth)
    : null;

  const prior = await getScanSchedule(projectId);
  const keepFailures = clean.enabled ? 0 : prior?.consecutiveFailures ?? 0;
  const keepPaused = clean.enabled ? null : prior?.pausedReason ?? null;
  const lastRunAt = prior?.lastRunAt ?? null;

  await sql`DELETE FROM scan_schedules WHERE project_id = ${projectId}`;
  await sql`
    INSERT INTO scan_schedules (
      project_id, enabled, cadence, day_of_week, day_of_month,
      email_enabled, recipients, send_mode,
      next_run_at, last_run_at, consecutive_failures, paused_reason, updated_at
    ) VALUES (
      ${projectId}, ${clean.enabled}, ${clean.cadence},
      ${clean.dayOfWeek}, ${clean.dayOfMonth},
      ${clean.emailEnabled}, ${JSON.stringify(clean.recipients)}::jsonb,
      ${clean.sendMode},
      ${nextRunAt ? nextRunAt.toISOString() : null},
      ${lastRunAt},
      ${keepFailures}, ${keepPaused}, NOW()
    )
  `;
  const saved = await getScanSchedule(projectId);
  if (!saved) throw new Error("schedule save readback failed");
  return saved;
}

/** Every enabled schedule whose fire time has passed. */
export async function listDueSchedules(now: Date = new Date()): Promise<ScanSchedule[]> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM scan_schedules
    WHERE enabled = TRUE
      AND next_run_at IS NOT NULL
      AND next_run_at <= ${now.toISOString()}
  `;
  return rows.map(rowToSchedule);
}

/**
 * Atomically claim a due schedule by advancing next_run_at past `now`.
 * Returns false if another sweep invocation already claimed it — the
 * WHERE next_run_at <= now guard makes double-fires no-ops.
 */
export async function claimDueSchedule(
  s: ScanSchedule,
  now: Date = new Date()
): Promise<boolean> {
  await ensureScheduleSchema();
  const sql = db();
  const next = computeNextRunAt(s.cadence, s.dayOfWeek, s.dayOfMonth, now);
  const rows = await sql`
    UPDATE scan_schedules
    SET next_run_at = ${next.toISOString()}
    WHERE project_id = ${s.projectId}
      AND enabled = TRUE
      AND next_run_at IS NOT NULL
      AND next_run_at <= ${now.toISOString()}
    RETURNING id
  `;
  return rows.length > 0;
}

// ── Run rows ──────────────────────────────────────────────────

export async function insertScanRun(input: {
  projectId: string;
  status: ScanRunStatus;
  jobId?: string | null;
  note?: string | null;
}): Promise<string> {
  await ensureScheduleSchema();
  const sql = db();
  const finished = input.status === "running" ? null : new Date().toISOString();
  const rows = await sql`
    INSERT INTO scan_schedule_runs (project_id, schedule_id, job_id, status, note, finished_at)
    VALUES (
      ${input.projectId},
      (SELECT id FROM scan_schedules WHERE project_id = ${input.projectId}),
      ${input.jobId ?? null}, ${input.status}, ${input.note ?? null}, ${finished}
    )
    RETURNING id
  `;
  return String(rows[0].id);
}

export async function attachJobToScanRun(runId: string, jobId: string): Promise<void> {
  await ensureScheduleSchema();
  const sql = db();
  await sql`UPDATE scan_schedule_runs SET job_id = ${jobId} WHERE id = ${runId}`;
}

/**
 * Atomically claim the still-running scan-run row for a job — the caller
 * that wins (exactly one, via the status='running' guard) owns finalization
 * (summary, email, failure bookkeeping). Everyone else gets null.
 */
export async function claimRunningScanRunByJob(
  jobId: string
): Promise<{ runId: string; projectId: string } | null> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    UPDATE scan_schedule_runs
    SET status = 'finalizing'
    WHERE job_id = ${jobId} AND status = 'running'
    RETURNING id, project_id
  `;
  if (!rows[0]) return null;
  return { runId: String(rows[0].id), projectId: String(rows[0].project_id) };
}

export async function finalizeScanRun(
  runId: string,
  input: {
    status: Exclude<ScanRunStatus, "running">;
    note?: string | null;
    summary?: ScanRunSummary | null;
    emailStatus?: string | null;
  }
): Promise<void> {
  await ensureScheduleSchema();
  const sql = db();
  await sql`
    UPDATE scan_schedule_runs SET
      status       = ${input.status},
      note         = COALESCE(${input.note ?? null}, note),
      summary      = COALESCE(${input.summary ? JSON.stringify(input.summary) : null}::jsonb, summary),
      email_status = COALESCE(${input.emailStatus ?? null}, email_status),
      finished_at  = NOW()
    WHERE id = ${runId}
  `;
}

export async function listScanRuns(
  projectId: string,
  limit = 12
): Promise<ScanRun[]> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM scan_schedule_runs
    WHERE project_id = ${projectId}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `;
  return rows.map((r) => ({
    id: String(r.id),
    projectId: String(r.project_id),
    jobId: r.job_id ? String(r.job_id) : null,
    status: (r.status === "finalizing" ? "running" : String(r.status)) as ScanRunStatus,
    note: (r.note as string) ?? null,
    summary: (r.summary as ScanRunSummary) ?? null,
    emailStatus: (r.email_status as string) ?? null,
    startedAt: new Date(r.started_at as string).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at as string).toISOString() : null,
  }));
}

/**
 * Runs stranded in 'running'/'finalizing' (superseded job, dead lambda)
 * get closed out by the next sweep instead of hanging forever. They do
 * NOT count toward auto-pause — the site didn't fail, the pipeline moved on.
 */
export async function closeStaleScanRuns(olderThanHours = 24): Promise<number> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    UPDATE scan_schedule_runs
    SET status = 'skipped',
        note = 'Run never finished (superseded or interrupted) — closed by the next sweep',
        finished_at = NOW()
    WHERE status IN ('running', 'finalizing')
      AND started_at < NOW() - make_interval(hours => ${olderThanHours})
    RETURNING id
  `;
  return rows.length;
}

// ── Success / failure bookkeeping (auto-pause) ────────────────

export async function recordScheduleSuccess(projectId: string): Promise<void> {
  await ensureScheduleSchema();
  const sql = db();
  await sql`
    UPDATE scan_schedules
    SET consecutive_failures = 0, paused_reason = NULL, last_run_at = NOW()
    WHERE project_id = ${projectId}
  `;
}

/**
 * Count a failed scheduled run. At AUTO_PAUSE_AFTER consecutive failures
 * the schedule disables itself and records why. Returns the new state.
 */
export async function recordScheduleFailure(
  projectId: string,
  reason: string
): Promise<{ failures: number; paused: boolean }> {
  await ensureScheduleSchema();
  const sql = db();
  const rows = await sql`
    UPDATE scan_schedules
    SET consecutive_failures = consecutive_failures + 1,
        last_run_at = NOW()
    WHERE project_id = ${projectId}
    RETURNING consecutive_failures
  `;
  const failures = (rows[0]?.consecutive_failures as number) ?? 1;
  const paused = failures >= AUTO_PAUSE_AFTER;
  if (paused) {
    await sql`
      UPDATE scan_schedules
      SET enabled = FALSE, paused_reason = ${reason.slice(0, 500)}
      WHERE project_id = ${projectId}
    `;
  }
  return { failures, paused };
}

/** Project-deletion cleanup — called from lib/db/projects.ts deleteProject. */
export async function deleteScheduleDataForProject(projectId: string): Promise<void> {
  await ensureScheduleSchema();
  const sql = db();
  await sql`DELETE FROM scan_schedules WHERE project_id = ${projectId}`;
  await sql`DELETE FROM scan_schedule_runs WHERE project_id = ${projectId}`;
}
