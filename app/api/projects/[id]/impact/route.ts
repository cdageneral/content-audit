// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/impact — save the Business Impact
//  inputs (industry benchmark choice, conversion override, value
//  per lead, GA4 AI referral visits, AI premium, AIO toggle).
//
//  These are the CLIENT'S numbers, persisted per project so the
//  page reopens with the same assumptions it was presented with.
//  No API spend happens here.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import { saveImpactInputs } from "@/lib/impact/data";
import {
  AI_PREMIUM_DEFAULT,
  industryByKey,
  type ImpactInputs,
} from "@/lib/impact/model";

export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

/** Clamp a numeric input, or null when absent/invalid — never a guess. */
function num(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(n, min), max);
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    const inputs: ImpactInputs = {
      industry: industryByKey((body.industry as string) ?? null)?.key ?? null,
      convRate: num(body.convRate, 0.05, 50),
      leadValue: num(body.leadValue, 0, 10_000_000),
      aiVisits: num(body.aiVisits, 0, 100_000_000),
      aiPremium: num(body.aiPremium, 0.1, 50) ?? AI_PREMIUM_DEFAULT,
      aioDiscount: Boolean(body.aioDiscount),
    };

    await saveImpactInputs(params.id, inputs);
    return NextResponse.json({ ok: true, inputs });
  } catch (err) {
    console.error("[impact] save failed:", err);
    return NextResponse.json({ error: "Save failed" }, { status: 500 });
  }
}
