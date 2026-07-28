// ─────────────────────────────────────────────────────────────
//  /api/projects/[id]/brand
//  GET — the project's brand profile + source list.
//  PUT — save human edits to the profile (body: { profile }).
//  Access-gated per handler, same as the other project APIs.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import {
  getBrandProfile,
  saveBrandProfile,
  listBrandSources,
} from "@/lib/brand/store";
import { sanitizeBrandProfile, summarizeBrandContext } from "@/lib/brand/types";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    const [stored, sources] = await Promise.all([
      getBrandProfile(params.id),
      listBrandSources(params.id),
    ]);
    return NextResponse.json({
      profile: stored?.profile ?? null,
      updatedAt: stored?.updatedAt ?? null,
      sources,
      summary: summarizeBrandContext(stored?.profile ?? null),
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/brand GET]`, err);
    return NextResponse.json({ error: "Failed to load brand profile" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || !body.profile) {
      return NextResponse.json({ error: "Invalid body — expected { profile }" }, { status: 400 });
    }
    const clean = sanitizeBrandProfile(body.profile);
    await saveBrandProfile(params.id, clean);
    return NextResponse.json({
      profile: clean,
      summary: summarizeBrandContext(clean),
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/brand PUT]`, err);
    return NextResponse.json({ error: "Failed to save brand profile" }, { status: 500 });
  }
}
