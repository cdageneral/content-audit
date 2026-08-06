// POST /api/projects/[id]/run
// Triggers a new audit run for the client site and optionally all competitors.
// The actual run logic lives in lib/run/start.ts — shared verbatim with the
// scheduled-scan sweep so a scheduled scan is exactly a pressed Run button.
//
// GET /api/projects/[id]/run
// Reports whether a COMPETITORS-ONLY run is currently allowed, so the UI can
// offer (or withhold) that cheaper mode before anything is spent. The same
// check runs again inside startProjectRun — this endpoint informs, it never
// enforces.
import { NextRequest, NextResponse } from "next/server";
import { startProjectRun, getClientRunFreshness } from "@/lib/run/start";

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));

    const result = await startProjectRun(params.id, {
      includeCompetitors: body.includeCompetitors ?? true,
      // Explicit false only. An absent or garbled flag must never silently
      // skip the client site — that changes what the run measures.
      includeClient: body.includeClient === false ? false : true,
      competitorIds: body.competitorIds,
    });

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    return NextResponse.json({
      ok: true,
      jobs: result.jobs,
      clientJobId: result.clientJobId,
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/run]`, err);
    return NextResponse.json({ error: "Failed to start run" }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const f = await getClientRunFreshness(params.id);
    return NextResponse.json({
      clientRun: {
        lastCompletedAt: f.lastCompletedAt ? f.lastCompletedAt.toISOString() : null,
        ageDays: f.ageDays,
        stale: f.stale,
        staleAfterDays: f.staleAfterDays,
      },
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/run GET]`, err);
    return NextResponse.json({ error: "Failed to read run freshness" }, { status: 500 });
  }
}
