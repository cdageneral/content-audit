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

// Rolling window: keep last N snapshots, need at least 2 with different pct values
const ETA_WINDOW = 8;

function computeEta(history: ProgressSnapshot[], currentPct: number): string | null {
  if (history.length < 2) return null;
  if (currentPct <= 0) return null;
  if (currentPct >= 100) return null;

  // Use oldest and newest snapshots in window for rate
  const oldest = history[0];
  const newest = history[history.length - 1];

  const elapsedMs = newest.timestamp - oldest.timestamp;
  const pctGained = newest.pct - oldest.pct;

  if (elapsedMs < 3000 || pctGained <= 0) return null; // not enough data yet

  const msPerPct = elapsedMs / pctGained;
  const remainingPct = 100 - currentPct;
  const remainingMs = msPerPct * remainingPct;
  const remainingSec = Math.round(remainingMs / 1000);

  if (remainingSec <= 0) return null;
  if (remainingSec < 60) return `~${remainingSec}s remaining`;

  const mins = Math.round(remainingSec / 60);
  if (mins === 1) return "~1 min remaining";
  if (mins < 60) return `~${mins} min remaining`;

  const hrs = Math.round(mins / 60);
  return `~${hrs}h remaining`;
}

export default function LiveAuditBanner({ initialJobs, projectId }: Props) {
  const router = useRouter();
  const [cancelling, setCancelling] = useState(false);

  const [jobMap, setJobMap] = useState<Map<string, JobProgressState>>(
    () =>
      new Map(
        initialJobs.map((j) => [
          j.id,
          {
            jobId: j.id,
            status: j.status,
            totalPages: j.total_pages,
            crawledPages: j.crawled_pages,
            scoredPages: j.scored_pages,
          },
        ])
      )
  );

  // ETA tracking: rolling window of (timestamp, overallPct) snapshots
  const [progressHistory, setProgressHistory] = useState<ProgressSnapshot[]>([
    { timestamp: Date.now(), pct: 0 },
  ]);

  const updateJob = useCallback((data: JobProgressState) => {
    setJobMap((prev) => {
      const next = new Map(prev);
      next.set(data.jobId, data);
      return next;
    });
  }, []);

  useEffect(() => {
    const sources: EventSource[] = [];
    let completedCount = 0;
    const total = initialJobs.length;

    initialJobs.forEach((job) => {
      const es = new EventSource(`/api/audit/${job.id}/progress`);

      es.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as JobProgressState;
          updateJob(data);

          if (data.status === "done" || data.status === "failed") {
            es.close();
            completedCount++;
            if (completedCount >= total) {
              setTimeout(() => router.refresh(), 1200);
            }
          }
        } catch {
          // ignore parse errors
        }
      };

      es.onerror = () => es.close();
      sources.push(es);
    });

    return () => sources.forEach((s) => s.close());
  }, []);

  // Compute aggregate totals
  const jobList = Array.from(jobMap.values());
  const activeJobs = jobList.filter(
    (j) => j.status !== "done" && j.status !== "failed"
  );

  const totalPages = jobList.reduce((s, j) => s + (j.totalPages || 0), 0);
  const crawledPages = jobList.reduce((s, j) => s + j.crawledPages, 0);
  const scoredPages = jobList.reduce((s, j) => s + j.scoredPages, 0);

  const crawlPct = totalPages > 0 ? Math.round((crawledPages / totalPages) * 100) : 0;
  const scorePct = totalPages > 0 ? Math.round((scoredPages / totalPages) * 100) : 0;
  const overallPct = Math.round(crawlPct * 0.4 + scorePct * 0.6);

  // Append to ETA history whenever overallPct changes
  useEffect(() => {
    if (overallPct <= 0) return;
    setProgressHistory((prev) => {
      const last = prev[prev.length - 1];
      // Only append if pct actually changed
      if (last && last.pct === overallPct) return prev;
      const next = [...prev, { timestamp: Date.now(), pct: overallPct }];
      return next.slice(-ETA_WINDOW);
    });
  }, [overallPct]);

  const eta = computeEta(progressHistory, overallPct);
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

  // All jobs completed
  if (activeJobs.length === 0 && jobList.length > 0) {
    return (
      <div
        className="anim-slide-r rounded-xl p-4 flex items-center gap-3"
        style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.25)" }}
      >
        <svg className="h-4 w-4 flex-shrink-0" style={{ color: "#34d399" }} fill="none"
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
    <div
      className="anim-slide-r rounded-xl p-4 space-y-4"
      style={{ background: "rgba(99,102,241,0.08)", border: "1px solid rgba(99,102,241,0.2)" }}
    >
      {/* Header row */}
      <div className="flex items-center gap-3">
        <div className="spinner flex-shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
            Audit in progress —{" "}
            {activeJobs.length} job{activeJobs.length !== 1 ? "s" : ""} running
          </p>
          <p className="text-xs" style={{ color: "var(--text-2)" }}>
            {stageLabel}
          </p>
        </div>

        {/* ETA */}
        {eta && (
          <span className="text-xs flex-shrink-0" style={{ color: "var(--text-3)" }}>
            {eta}
          </span>
        )}

        {/* Overall % badge */}
        <div
          className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-full flex-shrink-0"
          style={{ background: "rgba(99,102,241,0.15)", color: "var(--indigo)" }}
        >
          {overallPct}%
        </div>

        {/* Cancel */}
        <button
          onClick={handleCancel}
          disabled={cancelling}
          className="text-xs px-2 py-0.5 rounded-full flex-shrink-0"
          style={{
            background: "rgba(255,255,255,0.05)",
            border: "1px solid rgba(255,255,255,0.1)",
            color: "var(--text-3)",
            cursor: cancelling ? "not-allowed" : "pointer",
          }}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      </div>

      {/* Overall bar */}
      <ProgressBar
        label="Overall"
        pct={overallPct}
        current={null}
        total={null}
        color="rgba(99,102,241,0.85)"
        thick
      />

      {/* Crawl + Score detail */}
      <div className="grid grid-cols-2 gap-3">
        <ProgressBar
          label="Pages crawled"
          pct={crawlPct}
          current={crawledPages}
          total={totalPages}
          color="rgba(139,92,246,0.8)"
        />
        <ProgressBar
          label="Pages scored"
          pct={scorePct}
          current={scoredPages}
          total={totalPages}
          color="rgba(251,191,36,0.8)"
        />
      </div>
    </div>
  );
}

function ProgressBar({
  label, pct, current, total, color, thick = false,
}: {
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
        style={{ background: "rgba(255,255,255,0.06)" }}>
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
