// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/keyword-prefs
//    { headTerm: string | null, supporting: string[] | null }
//
//  Persist the per-URL keyword assignment (URL-level model,
//  2026-07-26): which stored ranked keyword is the page's head
//  term (matches its core intent), and which count as supporting.
//
//  Honesty guarantee: every value is validated against the
//  keywords that actually exist in the page's latest stored SERP
//  snapshot — a client cannot make the UI display a term the page
//  doesn't verifiably rank for. null = auto-derived behavior.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getPageForOptimize } from "@/lib/db/drafts";
import { listStoredKeywords, getPageVisibility } from "@/lib/serp/visibility";
import { upsertKeywordPrefs } from "@/lib/db/keywordPrefs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

type Params = { params: { pageId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle || !bundle.projectId) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    const body = await req.json().catch(() => null);
    const rawHead =
      typeof body?.headTerm === "string" && body.headTerm.trim()
        ? (body.headTerm as string).trim()
        : null;
    const rawSupporting: string[] | null = Array.isArray(body?.supporting)
      ? (body.supporting as unknown[])
          .filter((s): s is string => typeof s === "string")
          .map((s) => s.trim())
          .filter(Boolean)
          .slice(0, 50)
      : null;

    // Validation universe: keywords in the latest stored snapshot only.
    const stored = await listStoredKeywords(bundle.page.url);
    if (stored.length === 0) {
      return NextResponse.json(
        { error: "No stored SERP keywords for this URL yet — refresh SERP data first." },
        { status: 409 }
      );
    }
    const canon = new Map(stored.map((k) => [k.toLowerCase(), k]));

    const headTerm = rawHead ? canon.get(rawHead.toLowerCase()) ?? null : null;
    if (rawHead && !headTerm) {
      return NextResponse.json(
        { error: "headTerm must be one of this page's stored ranked keywords." },
        { status: 400 }
      );
    }
    const supporting =
      rawSupporting === null
        ? null
        : rawSupporting
            .map((s) => canon.get(s.toLowerCase()))
            .filter((s): s is string => Boolean(s))
            // The head term can't also be a supporting term.
            .filter((s) => !headTerm || s.toLowerCase() !== headTerm.toLowerCase());

    await upsertKeywordPrefs(bundle.projectId, bundle.page.url, {
      headTerm,
      supporting,
    });

    // Return the freshly-applied visibility so the client re-renders truth.
    const visibility = await getPageVisibility(bundle.page.url, bundle.projectId);
    return NextResponse.json({ ok: true, visibility });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/keyword-prefs POST]`, err);
    return NextResponse.json(
      { error: "Failed to save keyword preferences — please try again" },
      { status: 500 }
    );
  }
}
