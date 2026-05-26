import { notFound } from "next/navigation";
import { getJob, getScoresByJob } from "@/lib/db/client";
import { computeAuditSummary } from "@/lib/scoring";
import JobProgress from "@/components/JobProgress";
import AuditResults from "@/components/AuditResults";

export const revalidate = 0;

export default async function AuditPage({
  params,
}: {
  params: { jobId: string };
}) {
  const job = await getJob(params.jobId).catch(() => null);
  if (!job) return notFound();

  const isTerminal = job.status === "done" || job.status === "failed";

  let scores: Awaited<ReturnType<typeof getScoresByJob>> = [];
  let summary = null;

  if (isTerminal || job.scoredPages > 0) {
    scores = await getScoresByJob(job.id).catch(() => []);
    summary = computeAuditSummary(scores);
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <StatusBadge status={job.status} />
          <span className="text-slate-400 text-sm font-mono">{job.id}</span>
        </div>
        <h1 className="text-2xl font-bold text-white truncate">{job.url}</h1>
        {job.scopePrefix && (
          <p className="text-slate-400 text-sm mt-1">
            Scope: <code className="text-indigo-400">{job.scopePrefix}</code>
          </p>
        )}
      </div>

      {/* Live progress (shown while running) */}
      {!isTerminal && <JobProgress job={job} />}

      {/* Results (shown when scoring complete) */}
      {scores.length > 0 && summary && (
        <AuditResults job={job} scores={scores} summary={summary} />
      )}

      {/* Failed state */}
      {job.status === "failed" && (
        <div className="rounded-xl border border-red-800/50 bg-red-950/20 p-6">
          <h3 className="text-red-400 font-semibold mb-2">Audit Failed</h3>
          <p className="text-slate-400 text-sm">{job.errorMessage || "Unknown error"}</p>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    queued: "bg-slate-700 text-slate-300",
    discovering: "bg-blue-900/50 text-blue-400",
    crawling: "bg-violet-900/50 text-violet-400",
    scoring: "bg-amber-900/50 text-amber-400",
    done: "bg-emerald-900/50 text-emerald-400",
    failed: "bg-red-900/50 text-red-400",
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${map[status] ?? ""}`}
    >
      {status !== "done" && status !== "failed" && (
        <span className="h-1.5 w-1.5 rounded-full bg-current animate-pulse" />
      )}
      {status}
    </span>
  );
}
