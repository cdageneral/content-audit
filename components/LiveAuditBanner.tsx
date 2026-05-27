"use client";

import { useEffect, useState, useCallback } from "react";
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

interface Props {
  initialJobs: ActiveJob[];
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

export default function LiveAuditBanner({ initialJobs }: Props) {
  const router = useRouter();

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

  const [doneRefreshing, setDoneRefreshing] = useState(false);

  // Stable updater so the effect closure doesn't capture stale state
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
            // When all jobs finish, refresh the page so results appear
            if (completedCount >= total) {
              setDoneRefreshing(true);
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
  }, []); // connect once on mount

  const jobList = Array.from(jobMap.values());
  const activeJobs = jobList.filter(
    (j) => j.status !== "done" && j.status !== "failed"
  );

  // All jobs completed — hide banner (refresh will reload the page)
  if (activeJobs.length === 0 && jobList.length > 0) {
    return (
      <div
        className="anim-slide-r rounded-xl p-4 flex items-center gap-3"
        style={{
          background: "rgba(52,211,153,0.08)",
          border: "1px solid rgba(52,211,153,0.25)",
        }}
      >
        <svg
          className="h-4 w-4 flex-shrink-0"
          style={{ color: "#34d399" }}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
        <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>
          Audit complete — refreshing results…
        </p>
      </div>
    );
  }

  // Aggregate totals across all jobs
  const totalPages = jobList.reduce((s, j) => s + (j.totalPages || 0), 0);
  const crawledPages = jobList.reduce((s, j) => s + j.crawledPages, 0);
  const scoredPages = jobList.reduce((s, j) => s + j.scoredPages, 0);

  const crawlPct =
    totalPages > 0 ? Math.round((crawledPages / totalPages) * 100) : 0;
  const scorePct =
    totalPages > 0 ? Math.round((scoredPages / totalPages) * 100) : 0;

  // Overall progress: weight crawl 40%, score 60%
  const overallPct = Math.round(crawlPct * 0.4 + scorePct * 0.6);

  const stageLabel = getStageLabel(activeJobs);

  return (
    <div
      className="anim-slide-r rounded-xl p-4 space-y-4"
      style={{
        background: "rgba(99,102,241,0.08)",
        border: "1px solid rgba(99,102,241,0.2)",
      }}
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
        {/* Overall % badge */}
        <div
          className="text-xs font-mono tabular-nums px-2 py-0.5 rounded-full"
          style={{
            background: "rgba(99,102,241,0.15)",
            color: "var(--indigo)",
          }}
        >
          {overallPct}%
        </div>
      </div>

      {/* Overall progress bar */}
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
  label,
  pct,
  current,
  total,
  color,
  thick = false,
}: {
  label: string;
  pct: number;
  current: number | null;
  total: number | null;
  color: string;
  thick?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between items-baseline gap-2">
        <span className="text-xs truncate" style={{ color: "var(--text-3)" }}>
          {label}
        </span>
        <span
          className="text-xs font-mono tabular-nums flex-shrink-0"
          style={{ color: "var(--text-2)" }}
        >
          {current !== null && total !== null
            ? `${current} / ${total || "…"}`
            : `${pct}%`}
        </span>
      </div>
      <div
        className={`rounded-full overflow-hidden ${thick ? "h-2" : "h-1.5"}`}
        style={{ background: "rgba(255,255,255,0.06)" }}
      >
        <div
          className="h-full rounded-full transition-all duration-700 ease-out"
          style={{ width: `${pct}%`, background: color }}
        />
      </div>
      {current !== null && total !== null && (
        <div
          className="text-right text-xs font-mono tabular-nums"
          style={{ color: "var(--text-3)" }}
        >
          {pct}%
        </div>
      )}
    </div>
  );
}
