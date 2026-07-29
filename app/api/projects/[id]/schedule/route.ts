// ─────────────────────────────────────────────────────────────
//  /api/projects/[id]/schedule
//  GET — the project's scan schedule + recent scheduled-run history.
//  PUT — save the user-editable config (body: { schedule }).
//  Access-gated per handler, same as the other project APIs.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import {
  getScanSchedule,
  listScanRuns,
  saveScanSchedule,
} from "@/lib/schedule/store";
import { emailConfigured } from "@/lib/schedule/email";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    const [schedule, runs] = await Promise.all([
      getScanSchedule(params.id),
      listScanRuns(params.id),
    ]);
    return NextResponse.json({
      schedule,
      runs,
      emailConfigured: emailConfigured(),
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/schedule GET]`, err);
    return NextResponse.json({ error: "Failed to load schedule" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !body.schedule) {
      return NextResponse.json(
        { error: "Invalid body — expected { schedule }" },
        { status: 400 }
      );
    }
    const saved = await saveScanSchedule(params.id, body.schedule);
    return NextResponse.json({ schedule: saved });
  } catch (err) {
    console.error(`[api/projects/${params.id}/schedule PUT]`, err);
    return NextResponse.json({ error: "Failed to save schedule" }, { status: 500 });
  }
}
