// ─────────────────────────────────────────────────────────────
//  DELETE /api/projects/[id]/brand/sources/[sourceId]
//  Removes a source ROW only. Deliberately does not touch the
//  profile: extraction is one-shot and the human-edited profile
//  is the source of truth afterwards (the UI states this).
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import { deleteBrandSource, listBrandSources } from "@/lib/brand/store";

export const dynamic = "force-dynamic";

type Params = { params: { id: string; sourceId: string } };

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    await deleteBrandSource(params.id, params.sourceId);
    const sources = await listBrandSources(params.id);
    return NextResponse.json({ sources });
  } catch (err) {
    console.error(`[api/projects/${params.id}/brand/sources DELETE]`, err);
    return NextResponse.json({ error: "Failed to remove source" }, { status: 500 });
  }
}
