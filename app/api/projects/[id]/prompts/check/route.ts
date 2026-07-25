// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/prompts/check
//  Dispatch a prompt-check run: every active prompt × every engine,
//  queued via QStash (one message per prompt so each webhook
//  invocation stays well inside its time budget while the engines
//  run in parallel).
//
//  Cost control: each check is a PAID DataForSEO LLM call. A per-
//  project 24h cap (PROMPT_CHECK_DAILY_CAP, default 400 checks)
//  blocks runaway spend; every call's real cost lands in the usage
//  ledger (purpose "llm_prompt").
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { checkProjectAccess } from "@/lib/auth/access";
import { dfsLlmConfigured } from "@/lib/serp/llm";
import { listPrompts, countRecentChecks, PROMPT_ENGINES } from "@/lib/db/prompts";
import { enqueuePromptBatch } from "@/lib/queue/qstash";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

const DAILY_CAP = parseInt(process.env.PROMPT_CHECK_DAILY_CAP ?? "400", 10);

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const gate = await checkProjectAccess(params.id);
    if (!gate.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (!dfsLlmConfigured()) {
      return NextResponse.json(
        {
          error:
            "LLM prompt checks aren't configured — DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD are required.",
        },
        { status: 501 }
      );
    }

    const prompts = await listPrompts(params.id);
    if (prompts.length === 0) {
      return NextResponse.json(
        { error: "No prompts yet — add prompts to the set first." },
        { status: 409 }
      );
    }

    const engines = [...PROMPT_ENGINES];
    const plannedChecks = prompts.length * engines.length;
    const used = await countRecentChecks(params.id);
    if (used + plannedChecks > DAILY_CAP) {
      return NextResponse.json(
        {
          error: `This run needs ${plannedChecks} checks but only ${Math.max(
            0,
            DAILY_CAP - used
          )} remain in the 24h budget (${DAILY_CAP}/day per project). Try again later.`,
        },
        { status: 429 }
      );
    }

    const runId = randomUUID();
    // One prompt per message: the webhook fans the 4 engine calls out in
    // parallel, so per-message wall time ≈ the slowest single engine.
    for (const p of prompts) {
      await enqueuePromptBatch({
        projectId: params.id,
        runId,
        promptIds: [p.id],
        engines,
      });
    }

    return NextResponse.json({
      ok: true,
      runId,
      prompts: prompts.length,
      engines,
      checks: plannedChecks,
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/prompts/check POST]`, err);
    return NextResponse.json(
      { error: "Failed to dispatch prompt checks — please try again" },
      { status: 500 }
    );
  }
}
