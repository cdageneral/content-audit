import Link from "next/link";
import type { AuditJob } from "@/lib/types";

const STATUS_COLORS: Record<string, string> = {
  queued: "text-slate-500",
  discovering: "text-blue-600",
  crawling: "text-violet-600",
  scoring: "text-amber-600",
  done: "text-emerald-600",
  failed: "text-red-600",
};

export default function JobList({ jobs }: { jobs: AuditJob[] }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-xs text-slate-500 uppercase tracking-wide">
            <th className="text-left px-4 py-3">URL</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Pages</th>
            <th className="px-4 py-3">Started</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr
              key={job.id}
              className="border-b border-slate-200/70 hover:bg-slate-50 transition-colors"
            >
              <td className="px-4 py-3">
                <Link
                  href={`/audit/${job.id}`}
                  className="text-indigo-600 hover:text-indigo-500 truncate block max-w-sm"
                >
                  {job.url}
                </Link>
              </td>
              <td className="px-4 py-3 text-center">
                <span className={`text-xs font-semibold ${STATUS_COLORS[job.status]}`}>
                  {job.status}
                </span>
              </td>
              <td className="px-4 py-3 text-center text-slate-500 font-mono text-xs">
                {job.scoredPages}/{job.totalPages}
              </td>
              <td className="px-4 py-3 text-center text-slate-500 text-xs">
                {new Date(job.createdAt).toLocaleDateString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
