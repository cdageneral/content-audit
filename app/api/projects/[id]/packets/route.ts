// ─────────────────────────────────────────────────────────────
//  GET /api/projects/[id]/packets
//
//  "Export all packets": one implementation .docx per optimized
//  page (every URL in the project with a saved draft), zipped into
//  a single download. Each document is identical to the per-page
//  Export Packet — same builder (lib/optimize/packet.ts).
//
//  Sandboxed like the rest of the Optimize workbench: reads drafts
//  and simulations only, never real audit history, and makes no
//  model calls (docx assembly is pure DB + string work).
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import JSZip from "jszip";
import { Packer } from "docx";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import { buildPacket } from "@/lib/optimize/packet";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 120;

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const [detail, states] = await Promise.all([
      getProjectDetail(params.id).catch(() => null),
      getProjectOptimizeStates(params.id),
    ]);

    const entries = Object.values(states);
    if (entries.length === 0) {
      return NextResponse.json(
        { error: "No optimized pages yet — save a draft in the Optimize workbench first." },
        { status: 409 }
      );
    }

    const zip = new JSZip();
    const usedNames = new Set<string>();
    let added = 0;

    for (const st of entries) {
      try {
        const packet = await buildPacket(st.draftId, st.simulationId);
        if (!packet) continue;
        // Guard against slug collisions (distinct URLs can normalize alike).
        let name = `optimized-${packet.slug}-v${packet.version}.docx`;
        let n = 2;
        while (usedNames.has(name)) {
          name = `optimized-${packet.slug}-v${packet.version}-${n++}.docx`;
        }
        usedNames.add(name);
        const buffer = await Packer.toBuffer(packet.doc);
        zip.file(name, buffer);
        added++;
      } catch (err) {
        console.error(`[packets] skipped ${st.url}:`, err);
      }
    }

    if (added === 0) {
      return NextResponse.json(
        { error: "Could not build any packets — the underlying drafts may be unavailable." },
        { status: 409 }
      );
    }

    const zipBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const safeName =
      (detail?.clientName ?? "project")
        .replace(/[^a-zA-Z0-9-_ ]/g, "")
        .replace(/\s+/g, "-") || "project";

    return new NextResponse(new Uint8Array(zipBuffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="optimization-packets-${safeName}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/packets]`, err);
    return NextResponse.json({ error: "Failed to build packets" }, { status: 500 });
  }
}
