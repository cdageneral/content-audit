// ─────────────────────────────────────────────────────────────
//  lib/schedule/finalize.ts — close out a scheduled run when its
//  client job reaches a terminal status.
//
//  Called (dynamically, fully caught) from updateJobStatus in
//  lib/db/client.ts whenever ANY job hits 'done' or 'failed' —
//  every pipeline path funnels through there, so scheduled runs
//  can't leak no matter where a job finishes. Jobs that were not
//  started by the scheduler exit in one cheap UPDATE that matches
//  zero rows (claimRunningScanRunByJob), so the manual pipeline is
//  effectively untouched.
//
//  On success: reset the failure counter, write the honest delta
//  summary (this run vs the previous completed run — stored rows
//  only, no modeled numbers), and send the "what moved" email.
//  On failure: count it, auto-pause at the threshold, and send the
//  pause notice instead of silently retrying forever.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { getScoresByJob } from "@/lib/db/client";
import { medianGrade } from "@/lib/hub";
import {
  claimRunningScanRunByJob,
  finalizeScanRun,
  getScanSchedule,
  recordScheduleFailure,
  recordScheduleSuccess,
} from "./store";
import {
  buildPauseEmailHtml,
  buildScanEmailHtml,
  emailConfigured,
  sendScanEmail,
  type PageDelta,
} from "./email";
import type { ScanRunSummary } from "./types";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

function appUrl(path: string): string {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  return `${base}${path}`;
}

const round = (n: number): number => Math.round(n);

async function buildSummary(
  projectId: string,
  jobId: string
): Promise<{ summary: ScanRunSummary; movers: PageDelta[] }> {
  const sql = db();

  const current = (await getScoresByJob(jobId)).filter(
    (s) => s.modelVersion !== "error"
  );

  const prevRows = await sql`
    SELECT id FROM audit_jobs
    WHERE project_id = ${projectId}
      AND competitor_id IS NULL
      AND status = 'done'
      AND id <> ${jobId}
    ORDER BY completed_at DESC NULLS LAST
    LIMIT 1
  `;
  const previous = prevRows[0]?.id
    ? (await getScoresByJob(String(prevRows[0].id))).filter(
        (s) => s.modelVersion !== "error"
      )
    : [];

  const prevByUrl = new Map(previous.map((s) => [s.url, s]));
  const currByUrl = new Map(current.map((s) => [s.url, s]));

  const deltas: PageDelta[] = [];
  for (const s of current) {
    const p = prevByUrl.get(s.url);
    deltas.push({
      url: s.url,
      before: p ? round(p.overallScore) : null,
      after: round(s.overallScore),
      gradeBefore: p?.grade ?? null,
      gradeAfter: s.grade,
    });
  }
  for (const p of previous) {
    if (!currByUrl.has(p.url)) {
      deltas.push({
        url: p.url,
        before: round(p.overallScore),
        after: null,
        gradeBefore: p.grade,
        gradeAfter: null,
      });
    }
  }

  const changed = deltas.filter(
    (d) => d.before === null || d.after === null || d.before !== d.after || d.gradeBefore !== d.gradeAfter
  ).length;
  const improved = deltas.filter(
    (d) => d.before !== null && d.after !== null && d.after > d.before
  ).length;
  const declined = deltas.filter(
    (d) => d.before !== null && d.after !== null && d.after < d.before
  ).length;

  const avg = (list: { overallScore: number }[]): number | null =>
    list.length > 0
      ? round(list.reduce((a, s) => a + s.overallScore, 0) / list.length)
      : null;

  const summary: ScanRunSummary = {
    pages: current.length,
    changed: previous.length > 0 ? changed : current.length,
    avgBefore: avg(previous),
    avgAfter: avg(current),
    gradeBefore: previous.length > 0 ? medianGrade(previous) : null,
    gradeAfter: current.length > 0 ? medianGrade(current) : null,
    improved,
    declined,
  };

  const movers = deltas
    .filter((d) => d.before !== null && d.after !== null && d.before !== d.after)
    .sort((a, b) => Math.abs((b.after ?? 0) - (b.before ?? 0)) - Math.abs((a.after ?? 0) - (a.before ?? 0)))
    .slice(0, 6);

  return { summary, movers };
}

async function projectName(projectId: string): Promise<string> {
  const sql = db();
  const rows = await sql`
    SELECT client_name FROM projects WHERE id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  return String(rows[0]?.client_name ?? "your project");
}

/**
 * Entry point — called from updateJobStatus for every terminal job.
 * Idempotent: only the caller that atomically claims the still-running
 * scan-run row does any work; everyone else returns immediately.
 */
export async function finalizeScheduledJob(
  jobId: string,
  status: "done" | "failed",
  errorMessage?: string
): Promise<void> {
  const claim = await claimRunningScanRunByJob(jobId);
  if (!claim) return;

  const { runId, projectId } = claim;
  const schedule = await getScanSchedule(projectId);
  const name = await projectName(projectId);

  if (status === "failed") {
    const reason = errorMessage ?? "Audit failed";
    // "Superseded by new run" means a human started a fresh scan mid-run —
    // that's not a site failure and must not count toward auto-pause.
    if (/superseded/i.test(reason)) {
      await finalizeScanRun(runId, {
        status: "skipped",
        note: "Superseded by a manually started scan",
      });
      return;
    }
    const { failures, paused } = await recordScheduleFailure(projectId, reason);
    let emailStatus: string | null = null;
    if (paused && schedule?.emailEnabled && schedule.recipients.length > 0) {
      const { subject, html } = buildPauseEmailHtml({
        projectName: name,
        projectUrl: appUrl(`/projects/${projectId}/schedule`),
        reason,
      });
      emailStatus = await sendScanEmail({
        to: schedule.recipients,
        subject,
        html,
        projectId,
        purpose: "scan_pause_notice",
      });
    }
    await finalizeScanRun(runId, {
      status: "failed",
      note: paused
        ? `${reason} — schedule paused after ${failures} consecutive failures`
        : reason,
      emailStatus,
    });
    console.warn(
      `[schedule] Scheduled run failed for project ${projectId} (${failures} consecutive)${paused ? " — PAUSED" : ""}: ${reason}`
    );
    return;
  }

  // ── Success path ──────────────────────────────────────────
  await recordScheduleSuccess(projectId);
  const { summary, movers } = await buildSummary(projectId, jobId);

  const somethingMoved =
    summary.changed > 0 ||
    summary.improved > 0 ||
    summary.declined > 0 ||
    (summary.avgBefore !== null && summary.avgBefore !== summary.avgAfter);

  let emailStatus: string | null = null;
  const wantsEmail =
    schedule?.emailEnabled &&
    schedule.recipients.length > 0 &&
    (schedule.sendMode === "always" || somethingMoved);

  if (wantsEmail && schedule) {
    const { subject, html } = buildScanEmailHtml({
      projectName: name,
      projectUrl: appUrl(`/projects/${projectId}`),
      runDate: new Date(),
      summary,
      movers,
    });
    emailStatus = await sendScanEmail({
      to: schedule.recipients,
      subject,
      html,
      projectId,
      purpose: "scan_digest",
    });
  } else if (schedule?.emailEnabled && schedule.recipients.length > 0) {
    emailStatus = "skipped_no_changes";
  } else if (schedule?.emailEnabled && !emailConfigured()) {
    emailStatus = "skipped_no_key";
  }

  await finalizeScanRun(runId, {
    status: "completed",
    summary,
    emailStatus,
  });
  console.log(
    `[schedule] Scheduled run completed for project ${projectId}: ${summary.pages} pages, ${summary.changed} changed, email=${emailStatus ?? "off"}`
  );
}
