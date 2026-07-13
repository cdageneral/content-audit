"use client";

import { useEffect, useState } from "react";
import type { AuditJob } from "@/lib/types";
import { useRouter } from "next/navigation";

interface Props {
  job: AuditJob;
}

interface ProgressState {
  status: string;
  totalPages: number;
  crawledPages: number;
  scoredPages: number;
  errorMessage?: string;
}

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued",
  discovering: "Discovering URLs via sitemap…",
  crawling: "Crawling pages…",
  scoring: "Scoring with Claude…",
  done: "Complete",
  failed: "Failed",
};

export default function JobProgress({ job }: Props) {
  const router = useRouter();
  const [progress, setProgress] = useState<ProgressState>({
    status: job.status,
    totalPages: job.totalPages,
    crawledPages: job.crawledPages,
    scoredPages: job.scoredPages,
  });

  useEffect(() => {
    const evtSource = new EventSource(`/api/audit/${job.id}/progress`);

    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as ProgressState;
        setProgress(data);

        if (data.status === "done" || data.status === "failed") {
          evtSource.close();
          // Reload the page to show results
          setTimeout(() => router.refresh(), 800);
        }
      } catch {
        // ignore parse errors
      }
    };

    evtSource.onerror = () => evtSource.close();

    return () => evtSource.close();
  }, [job.id, router]);

  const crawlPct =
    progress.totalPages > 0
      ? Math.round((progress.crawledPages / progress.totalPages) * 100)
      : 0;
  const scorePct =
    progress.totalPages > 0
      ? Math.round((progress.scoredPages / progress.totalPages) * 100)
      : 0;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Spinner />
        <span className="text-slate-900 font-medium">
          {STAGE_LABELS[progress.status] ?? progress.status}
        </span>
      </div>

      {/* Crawl progress */}
      <ProgressBar
        label="Pages Crawled"
        current={progress.crawledPages}
        total={progress.totalPages}
        pct={crawlPct}
        color="bg-violet-500"
      />

      {/* Score progress */}
      <ProgressBar
        label="Pages Scored"
        current={progress.scoredPages}
        total={progress.totalPages}
        pct={scorePct}
        color="bg-amber-500"
      />

      {progress.errorMessage && (
        <p className="text-red-600 text-sm">{progress.errorMessage}</p>
      )}
    </div>
  );
}

function ProgressBar({
  label,
  current,
  total,
  pct,
  color,
}: {
  label: string;
  current: number;
  total: number;
  pct: number;
  color: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-sm">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-700 font-mono">
          {current} / {total || "…"} ({pct}%)
        </span>
      </div>
      <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg
      className="h-5 w-5 animate-spin text-indigo-600"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
