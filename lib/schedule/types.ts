// ─────────────────────────────────────────────────────────────
//  lib/schedule/types.ts — Scan Schedule types + cadence math.
//
//  ⚠️ CLIENT-SAFE: imported by client components (ScanScheduleView)
//  as well as the server store/routes. Keep this file free of any
//  server import (no neon, no node APIs) — same rule as
//  lib/brand/types.ts.
//
//  Cadence model (Wayne-chosen presets, 2026-07-29):
//   • weekly        — every week on dayOfWeek (0=Sun … 6=Sat)
//   • twice_monthly — the 1st and 15th (fixed; no day picker)
//   • monthly       — every month on dayOfMonth (1–28)
//
//  All runs fire at RUN_HOUR_UTC (09:00 UTC ≈ 2 AM Pacific in
//  summer, 1 AM in winter) via the daily sweep cron. next_run_at
//  is stored as an absolute timestamp; the sweep picks up every
//  schedule whose next_run_at has passed — so a missed day (cron
//  hiccup) is caught on the next sweep instead of skipped.
// ─────────────────────────────────────────────────────────────

export type ScanCadence = "weekly" | "twice_monthly" | "monthly";
export type ScanSendMode = "always" | "changes";

/** Hour-of-day (UTC) scheduled scans fire. 09:00 UTC ≈ overnight Pacific. */
export const RUN_HOUR_UTC = 9;

/** A manual scan inside this window makes the scheduled one redundant. */
export const MANUAL_SKIP_HOURS = 72;

/** Consecutive failed scheduled runs before the schedule pauses itself. */
export const AUTO_PAUSE_AFTER = 2;

export interface ScanSchedule {
  projectId: string;
  enabled: boolean;
  cadence: ScanCadence;
  /** 0=Sunday … 6=Saturday. Used when cadence === 'weekly'. */
  dayOfWeek: number;
  /** 1–28. Used when cadence === 'monthly'. */
  dayOfMonth: number;
  emailEnabled: boolean;
  recipients: string[];
  sendMode: ScanSendMode;
  nextRunAt: string | null;
  lastRunAt: string | null;
  consecutiveFailures: number;
  /** Non-null when the schedule paused itself after repeated failures. */
  pausedReason: string | null;
  updatedAt: string | null;
}

export type ScanRunStatus = "running" | "completed" | "failed" | "skipped";

/** Honest per-run summary — every number derives from stored score rows. */
export interface ScanRunSummary {
  pages: number;
  /** URLs whose stored score/grade differs from the previous run (incl. new URLs). */
  changed: number;
  avgBefore: number | null;
  avgAfter: number | null;
  gradeBefore: string | null;
  gradeAfter: string | null;
  improved: number;
  declined: number;
}

export interface ScanRun {
  id: string;
  projectId: string;
  jobId: string | null;
  status: ScanRunStatus;
  note: string | null;
  summary: ScanRunSummary | null;
  emailStatus: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const CADENCE_LABELS: Record<ScanCadence, string> = {
  weekly: "Weekly",
  twice_monthly: "Twice a month",
  monthly: "Monthly",
};

export const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function emptyScanSchedule(projectId: string): ScanSchedule {
  return {
    projectId,
    enabled: false,
    cadence: "twice_monthly",
    dayOfWeek: 4, // Thursday
    dayOfMonth: 1,
    emailEnabled: true,
    recipients: [],
    sendMode: "always",
    nextRunAt: null,
    lastRunAt: null,
    consecutiveFailures: 0,
    pausedReason: null,
    updatedAt: null,
  };
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? Math.round(v) : parseInt(String(v), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Coerce untrusted JSON (client PUT or DB row) into a valid ScanSchedule. */
export function sanitizeScanSchedule(
  raw: unknown,
  projectId: string
): ScanSchedule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const cadence: ScanCadence =
    r.cadence === "weekly" || r.cadence === "monthly" || r.cadence === "twice_monthly"
      ? r.cadence
      : "twice_monthly";
  const recipients = Array.isArray(r.recipients)
    ? Array.from(
        new Set(
          r.recipients
            .map((e) => String(e ?? "").trim().toLowerCase())
            .filter((e) => e.length > 0 && e.length <= 254 && EMAIL_RE.test(e))
        )
      ).slice(0, 10)
    : [];
  return {
    projectId,
    enabled: r.enabled === true,
    cadence,
    dayOfWeek: clampInt(r.dayOfWeek, 0, 6, 4),
    dayOfMonth: clampInt(r.dayOfMonth, 1, 28, 1),
    emailEnabled: r.emailEnabled !== false,
    recipients,
    sendMode: r.sendMode === "changes" ? "changes" : "always",
    nextRunAt: typeof r.nextRunAt === "string" ? r.nextRunAt : null,
    lastRunAt: typeof r.lastRunAt === "string" ? r.lastRunAt : null,
    consecutiveFailures: clampInt(r.consecutiveFailures, 0, 1000, 0),
    pausedReason:
      typeof r.pausedReason === "string" && r.pausedReason ? r.pausedReason : null,
    updatedAt: typeof r.updatedAt === "string" ? r.updatedAt : null,
  };
}

const atRunHour = (y: number, m: number, d: number): Date =>
  new Date(Date.UTC(y, m, d, RUN_HOUR_UTC, 0, 0, 0));

/**
 * The next fire time strictly AFTER `from` for the given cadence.
 * Pure UTC math — no timezone library needed at day granularity.
 */
export function computeNextRunAt(
  cadence: ScanCadence,
  dayOfWeek: number,
  dayOfMonth: number,
  from: Date = new Date()
): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth();
  const d = from.getUTCDate();

  if (cadence === "weekly") {
    for (let add = 0; add <= 7; add++) {
      const cand = atRunHour(y, m, d + add);
      if (cand.getUTCDay() === ((dayOfWeek % 7) + 7) % 7 && cand > from) return cand;
    }
    // Unreachable, but keep the compiler + runtime honest.
    return atRunHour(y, m, d + 7);
  }

  if (cadence === "twice_monthly") {
    const candidates = [
      atRunHour(y, m, 1),
      atRunHour(y, m, 15),
      atRunHour(y, m + 1, 1),
      atRunHour(y, m + 1, 15),
    ];
    return candidates.find((c) => c > from) ?? candidates[candidates.length - 1];
  }

  // monthly
  const day = Math.min(28, Math.max(1, dayOfMonth));
  const thisMonth = atRunHour(y, m, day);
  return thisMonth > from ? thisMonth : atRunHour(y, m + 1, day);
}

/** The next `count` fire times — used by the UI preview strip. */
export function nextRunPreview(
  cadence: ScanCadence,
  dayOfWeek: number,
  dayOfMonth: number,
  count = 3,
  from: Date = new Date()
): Date[] {
  const out: Date[] = [];
  let cursor = from;
  for (let i = 0; i < count; i++) {
    const next = computeNextRunAt(cadence, dayOfWeek, dayOfMonth, cursor);
    out.push(next);
    cursor = next;
  }
  return out;
}
