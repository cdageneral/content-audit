// ─────────────────────────────────────────────────────────────
//  GET /api/optimize/[pageId]/export?draftId=…&simulationId=…
//  Implementation packet (.docx): the final optimized copy, a
//  change summary, the baseline-vs-simulated score table, an
//  implementation checklist, and the methodology stamp — the
//  deliverable a client hands to whoever publishes the change.
//
//  The document itself is built in lib/optimize/packet.ts, shared
//  with the project-wide "export all" bundle route.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { Packer } from "docx";
import { buildPacket } from "@/lib/optimize/packet";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { pageId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const draftId = req.nextUrl.searchParams.get("draftId") ?? "";
    const simulationId = req.nextUrl.searchParams.get("simulationId") ?? "";
    if (!draftId) {
      return NextResponse.json({ error: "draftId is required" }, { status: 400 });
    }

    const packet = await buildPacket(draftId, simulationId, params.pageId);
    if (!packet) {
      return NextResponse.json({ error: "Draft or page not found" }, { status: 404 });
    }

    const buffer = await Packer.toBuffer(packet.doc);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="optimized-${packet.slug}-v${packet.version}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/export GET]`, err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}
