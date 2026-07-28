// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/brand/sources
//  Add a brand source and extract it into the profile in one
//  synchronous call (a single Claude extraction — no queue).
//   • multipart/form-data with a "file" field (pdf/docx/pptx/md/txt), or
//   • JSON { url } to fetch a page (about page, brand page).
//  On success returns the merged profile + the new source row.
//  A failed extraction records an error source row so the user
//  sees what happened — the profile is never touched on failure.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import {
  getBrandProfile,
  saveBrandProfile,
  insertBrandSource,
  listBrandSources,
} from "@/lib/brand/store";
import {
  fileToSourceInput,
  urlToSourceInput,
  extractProfileFromSource,
  type SourceInput,
} from "@/lib/brand/extract";
import { summarizeBrandContext } from "@/lib/brand/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { id: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    // ── Build the source input from either transport ──
    let source: SourceInput;
    try {
      const ctype = req.headers.get("content-type") ?? "";
      if (ctype.includes("multipart/form-data")) {
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          return NextResponse.json({ error: "No file in upload" }, { status: 400 });
        }
        source = await fileToSourceInput(file.name, await file.arrayBuffer());
      } else {
        const body = await req.json().catch(() => null);
        const url = body && typeof body.url === "string" ? body.url.trim() : "";
        if (!url) {
          return NextResponse.json(
            { error: "Send a file upload or a JSON body with { url }" },
            { status: 400 }
          );
        }
        source = await urlToSourceInput(url);
      }
    } catch (err) {
      // Input-shaping problems are the user's to fix — surface the message.
      const msg = err instanceof Error ? err.message : "Couldn't read that source";
      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // ── Extract + merge ──
    const existing = await getBrandProfile(params.id);
    try {
      const merged = await extractProfileFromSource(
        params.id,
        source,
        existing?.profile ?? null
      );
      await saveBrandProfile(params.id, merged);
      await insertBrandSource({
        projectId: params.id,
        kind: source.kind,
        name: source.name,
        detail: source.detail,
        status: "done",
      });
      const sources = await listBrandSources(params.id);
      return NextResponse.json({
        profile: merged,
        sources,
        summary: summarizeBrandContext(merged),
      });
    } catch (err) {
      console.error(`[api/projects/${params.id}/brand/sources POST extract]`, err);
      await insertBrandSource({
        projectId: params.id,
        kind: source.kind,
        name: source.name,
        detail: source.detail,
        status: "error",
        error: "Extraction failed",
      }).catch(() => null);
      return NextResponse.json(
        { error: "Extraction failed — the source was readable but the AI pass errored. Try again." },
        { status: 502 }
      );
    }
  } catch (err) {
    console.error(`[api/projects/${params.id}/brand/sources POST]`, err);
    return NextResponse.json({ error: "Failed to add source" }, { status: 500 });
  }
}
