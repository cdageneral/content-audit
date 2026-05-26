// GET /api/audit/[jobId] — Job status + full results
import { NextRequest, NextResponse } from "next/server";
import { getJob, getScoresByJob } from "@/lib/db/client";
import { computeAuditSummary } from "@/lib/scoring";

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
