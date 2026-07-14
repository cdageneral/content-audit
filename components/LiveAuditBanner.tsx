"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";

interface ActiveJob {
  id: string;
  competitor_id: string | null;
  status: string;
  crawled_pages: number;
  total_pages: number;
  scored_pages: number;
}

interface JobProgressState {
  jobId: string;
  status: string;
  totalPages: number;
  crawledPages: number;
  scoredPages: number;
}

interface ProgressSnapshot {
  timestamp: number;
  pct: number;
}

interface Props {
  initialJobs: ActiveJob[];
  projectId: string;
}

const STAGE_PRIORITY = ["scoring", "crawling", "discovering", "queued"] as const;
const STAGE_LABELS: Record<string, string> = {
  scoring: "Scoring pages with Claude…",
  crawling: "Crawling and extracting content…",
  discovering: "Discovering URLs via sitemap…",
  queued: "Waiting to start…",
};

function getStageLabel(jobs: JobProgressState[]): string {
  for (const stage of STAGE_PRIORITY) {
    if (jobs.some((j) => j.status === stage)) return STAGE_LABELS[stage];
  }
  return "Processing…";
}

const ETA_WINDOW = 8;

// Returns remaining ms based on rolling rate, or null if not enough data
function computeRemainingMs(history: ProgressSnapshot[], currentPct: number): number | null {
  if (history.length < 2 || currentPct <= 0 || currentPct >= 100) return null;
  const oldest = history[0];
  const newest = history[history.length - 1];
  const elapsedMs = newest.timestamp - oldest.timestamp;
  const pctGained = newest.pct - oldest.pct;
  if (elapsedMs < 3000 || pctGained <= 0) return null;
  const msPerPct = elapsedMs / pctGained;
  return msPerPct * (100 - currentPct);
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hrs}h ${remMins}m` : `${hrs}h`;
}

export default function LiveAuditBanner({ initialJobs, projectId }: Props) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);

  const [jobMap, setJobMap] = useState<Map<string, JobProgressState>>(
    () => new Map(initialJobs.map((j) => [j.id, {
      jobId: j.id, status: j.status,
      totalPages: j.total_pages, crawledPages: j.crawled_pages, scoredPages: j.scored_pages,
    }]))
  );

  const [progressHistory, setProgressHistory] = useState<ProgressSnapshot[]>([
    { timestamp: Date.now(), pct: 0 },
  ]);

  // Deadline = Date.now() + remainingMs, updated whenever rate is recalculated
  const etaDeadlineRef = useRef<number | null>(null);
  const [countdownMs, setCountdownMs] = useState<number | null>(null);

  const updateJob = useCallback((data: JobProgressState) => {
    setJobMap((prev) => { const next = new Map(prev); next.set(data.jobId, data); return next; });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const finished = new Set<string>();
    const total = initialJobs.length;

    async function pollOnce() {
      await Promise.all(
        initialJobs.map(async (job) => {
          if (finished.has(job.id)) return;
          try {
            const res = await fetch(`/api/audit/${job.id}?t=${Date.now()}`, {
              cache: "no-store",
            });
            if (!res.ok || cancelled) return;
            const { job: j } = await res.json();
            if (!j || cancelled) return;
            updateJob({
              jobId: j.id,
              status: j.status,
              totalPages: j.totalPages,
              crawledPages: j.crawledPages,
              scoredPages: j.scoredPages,
            });
            if (j.status === "done" || j.status === "failed") {
              finished.add(job.id);
              if (finished.size >= total && !cancelled) {
                setTimeout(() => router.refresh(), 1200);
              }
            }
          } catch {}
        })
      );
    }

    // Poll on a fixed interval instead of an EventSource. The SSE progress
    // stream was killed by Vercel at 120s, which froze the bar mid-audit and
    // made finished runs look hung. Polling the (force-dynamic) status route
    // has no such ceiling and always reflects real backend state.
    pollOnce();
    const id = setInterval(pollOnce, 3000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Live countdown ticker — runs every second
  useEffect(() => {
    const id = setInterval(() => {
      if (etaDeadlineRef.current === null) return;
      const remaining = etaDeadlineRef.current - Date.now();
      setCountdownMs(remaining > 0 ? remaining : 0);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Aggregate totals
  const jobList = Array.from(jobMap.values());
  const activeJobs = jobList.filter((j) => j.status !== "done" && j.status !== "failed");
  const totalPages = jobList.reduce((s, j) => s + (j.totalPages || 0), 0);
  const crawledPages = jobList.reduce((s, j) => s + j.crawledPages, 0);
  const scoredPages = jobList.reduce((s, j) => s + j.scoredPages, 0);
  const crawlPct = totalPages > 0 ? Math.min(100, Math.round((crawledPages / totalPages) * 100)) : 0;
  const scorePct = totalPages > 0 ? Math.min(100, Math.round((scoredPages / totalPages) * 100)) : 0;
  const overallPct = Math.min(100, Math.round(crawlPct * 0.4 + scorePct * 0.6));

  // Update ETA history and deadline whenever overallPct changes
  useEffect(() => {
    if (overallPct <= 0) return;
    setProgressHistory((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.pct === overallPct) return prev;
      const next = [...prev, { timestamp: Date.now(), pct: overallPct }].slice(-ETA_WINDOW);
      const remainingMs = computeRemainingMs(next, overallPct);
      if (remainingMs !== null) {
        etaDeadlineRef.current = Date.now() + remainingMs;
        setCountdownMs(remainingMs);
      }
      return next;
    });
  }, [overallPct]);

  const stageLabel = getStageLabel(activeJobs);

  async function handleCancel() {
    setCancelling(true);
    try {
      await fetch(`/api/projects/${projectId}/cancel`, { method: "POST" });
      router.refresh();
    } finally {
      setCancelling(false);
    }
  }

  // All done
  if (activeJobs.length === 0 && jobList.length > 0) {
    return (
      <div className="anim-slide-r rounded-xl p-4 flex items-center gap-3"
        style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)" }}>
        <svg className="h-4 w-4 flex-shrink-0" style={{ color: "#059669" }} fill="none"
          viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
          Audit complete — refreshing results…
        </p>
      </div>
    );
  }

  return (
    <div className="anim-slide-r rounded-xl p-4 space-y-4"
      style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}>

      {/* Header row */}
      <div className="flex items-center gap-3">
        <div className="spinner flex-shrink-0" />

        {/* Stage info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
            Audit in progress — {activeJobs.length} job{activeJobs.length !== 1 ? "s" : ""} running
          </p>
          <p className="text-xs" style={{ color: "var(--text-2)" }}>{stageLabel}</p>
        </div>

        {/* ETA countdown + % block */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Countdown */}
          {countdownMs !== null && countdownMs > 0 && (
            <div className="text-right">
              <div className="text-xs" style={{ color: "var(--text-3)" }}>est. remaining</div>
              <div className="text-sm font-mono font-medium tabular-nums"
                style={{ color: "var(--text-2)", letterSpacing: "0.02em" }}>
                {formatCountdown(countdownMs)}
              </div>
            </div>
          )}

          {/* Large % badge */}
          <div className="flex items-center justify-center rounded-full flex-shrink-0"
            style={{
              width: 56, height: 56,
              background: "rgba(99,102,241,0.15)",
              border: "2px solid rgba(99,102,241,0.3)",
            }}>
            <span className="font-bold tabular-nums"
              style={{ fontSize: 16, color: "var(--indigo)", lineHeight: 1 }}>
              {overallPct}%
            </span>
          </div>

          {/* Cancel */}
          <button onClick={handleCancel} disabled={cancelling}
            className="text-xs px-3 py-1.5 rounded-full flex-shrink-0"
            style={{
              background: "rgba(15,23,42,0.06)",
              border: "1px solid rgba(15,23,42,0.12)",
              color: "var(--text-3)",
              cursor: cancelling ? "not-allowed" : "pointer",
            }}>
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      </div>

      {/* Overall bar */}
      <ProgressBar label="Overall" pct={overallPct} current={null} total={null}
        color="rgba(99,102,241,0.85)" thick />

      {/* Crawl + Score detail */}
      <div className="grid grid-cols-2 gap-3">
        <ProgressBar label="Pages crawled" pct={crawlPct}
          current={crawledPages} total={totalPages} color="rgba(139,92,246,0.8)" />
        <ProgressBar label="Pages scored" pct={scorePct}
          current={scoredPages} total={totalPages} color="rgba(251,191,36,0.8)" />
      </div>
    </div>
  );
}

function ProgressBar({ label, pct, current, total, color, thick = false }: {
  label: string; pct: number; current: number | null; total: number | null;
  color: string; thick?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-xs truncate" style={{ color: "var(--text-3)" }}>{label}</span>
        <span className="text-xs font-mono tabular-nums flex-shrink-0" style={{ color: "var(--text-2)" }}>
          {current !== null && total !== null ? `${current} / ${total || "…"}` : `${pct}%`}
        </span>
      </div>
      <div className={`rounded-full overflow-hidden ${thick ? "h-2" : "h-1.5"}`}
        style={{ background: "rgba(15,23,42,0.06)" }}>
        <div className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, background: color }} />
      </div>
      {current !== null && total !== null && (
        <div className="text-right text-xs font-mono tabular-nums" style={{ color: "var(--text-3)" }}>
          {pct}%
        </div>
      )}
    </div>
  );
}
