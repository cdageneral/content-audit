// POST /api/projects/[id]/run
// Triggers a new audit run for the client site and optionally all competitors.
// The actual run logic lives in lib/run/start.ts — shared verbatim with the
// scheduled-scan sweep so a scheduled scan is exactly a pressed Run button.
import { NextRequest, NextResponse } from "next/server";
import { startProjectRun } from "@/lib/run/start";

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));

    const result = await startProjectRun(params.id, {
      includeCompetitors: body.includeCompetitors ?? true,
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
