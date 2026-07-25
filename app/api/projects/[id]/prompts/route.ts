// ─────────────────────────────────────────────────────────────
//  /api/projects/[id]/prompts — LLM Prompt Set management.
//    GET    → prompt rows (latest check per engine) + last-run summary
//    POST   { add: string[] }            → add prompts (dedup, cap 50)
//    PATCH  { promptId, targetUrl }      → assign/unassign a page URL
//    DELETE ?promptId=…                  → soft-delete a prompt
//  No provider calls here — checks run via /prompts/check.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { checkProjectAccess } from "@/lib/auth/access";
import {
  getPromptRows,
  addPrompts,
  deletePrompt,
  setPromptTarget,
  getLastRunSummary,
} from "@/lib/db/prompts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const [rows, lastRun] = await Promise.all([
      getPromptRows(params.id),
      getLastRunSummary(params.id).catch(() => null),
    ]);
    return NextResponse.json({ prompts: rows, lastRun });
  } catch (err) {
    console.error(`[api/projects/${params.id}/prompts GET]`, err);
    return NextResponse.json({ error: "Failed to load prompts" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const add: string[] = Array.isArray(body?.add)
      ? (body.add as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    if (add.length === 0) {
      return NextResponse.json({ error: "No prompts provided" }, { status: 400 });
    }
    const result = await addPrompts(params.id, add.slice(0, 50));
    const rows = await getPromptRows(params.id);
    return NextResponse.json({ ...result, prompts: rows });
  } catch (err) {
    console.error(`[api/projects/${params.id}/prompts POST]`, err);
    return NextResponse.json({ error: "Failed to add prompts" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const body = await req.json().catch(() => null);
    const promptId = typeof body?.promptId === "string" ? body.promptId : null;
    const targetUrl =
      typeof body?.targetUrl === "string" && body.targetUrl.trim()
        ? (body.targetUrl as string).trim()
        : null;
    if (!promptId) {
      return NextResponse.json({ error: "promptId is required" }, { status: 400 });
    }
    await setPromptTarget(params.id, promptId, targetUrl);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[api/projects/${params.id}/prompts PATCH]`, err);
    return NextResponse.json({ error: "Failed to update prompt" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const promptId = req.nextUrl.searchParams.get("promptId");
    if (!promptId) {
      return NextResponse.json({ error: "promptId is required" }, { status: 400 });
    }
    await deletePrompt(params.id, promptId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error(`[api/projects/${params.id}/prompts DELETE]`, err);
    return NextResponse.json({ error: "Failed to delete prompt" }, { status: 500 });
  }
}
