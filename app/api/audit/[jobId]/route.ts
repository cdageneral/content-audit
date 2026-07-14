// GET /api/audit/[jobId] — Job status + full results
import { NextRequest, NextResponse } from "next/server";
import { getJob, getScoresByJob } from "@/lib/db/client";
import { computeAuditSummary } from "@/lib/scoring";

// Never cache: the live banner polls this for real-time job status. A cached
// snapshot would report a stale status/counters (e.g. `scoring`/0 for a job
// that is actually done) and make finished audits look stuck.
export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;

  try {
    const job = await getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const scores = await getScoresByJob(jobId);
    const summary = computeAuditSummary(scores);

    return NextResponse.json({ job, pages: scores, summary });
  } catch (err) {
    console.error(`[api/audit/${jobId} GET]`, err);
    return NextResponse.json({ error: "Failed to load results" }, { status: 500 });
  }
}
