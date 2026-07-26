// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/prompt-set
//
//  Generate this page's buyer-intent prompt set from its SCORED
//  quality dimensions (URL-level model, 2026-07-26): the head
//  search term matches the page's core intent; prompts probe the
//  four content-quality dimensions — core intent, edge cases,
//  implied questions, and fan-out queries.
//
//  Inputs are all REAL stored data: the crawled page content, the
//  auditor's per-dimension rationale/recommendations, and (when a
//  SERP snapshot exists) the verbatim People-Also-Ask questions.
//  The model maps them into prompts a buyer would actually type —
//  it invents no facts, and nothing here estimates volume (no
//  unmodeled prompt-volume figures exist, so none are shown).
//
//  Prompts land in project_prompts with target_url = this page,
//  dimension-labeled, source 'generated', editable/removable like
//  any manual prompt. Caps: 12 per URL, 150 per project, dedupe
//  project-wide. One Anthropic call per invocation (usage ledger
//  purpose "prompt_gen"); checks against live engines remain a
//  separate, explicitly-triggered paid step.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { getPageForOptimize } from "@/lib/db/drafts";
import {
  addGeneratedPrompts,
  getPromptRowsForUrl,
  listPrompts,
  urlKey,
  MAX_PROMPTS_PER_URL,
  PROMPT_DIMENSIONS,
} from "@/lib/db/prompts";
import type { PromptDimension } from "@/lib/db/prompts";
import { recordAnthropicCall } from "@/lib/usage/record";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { pageId: string } };

const GEN_MODEL = process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

export async function POST(_req: NextRequest, { params }: Params) {
  try {
    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle || !bundle.projectId) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json(
        { error: "Prompt generation isn't configured — ANTHROPIC_API_KEY is required." },
        { status: 501 }
      );
    }

    const page = bundle.page;
    const key = urlKey(page.url);
    const existing = await listPrompts(bundle.projectId);
    const onUrl = existing.filter(
      (p) => p.targetUrl && urlKey(p.targetUrl) === key
    ).length;
    if (onUrl >= MAX_PROMPTS_PER_URL) {
      return NextResponse.json(
        {
          error: `This page already has ${onUrl} prompts (cap ${MAX_PROMPTS_PER_URL}). Remove some before generating more.`,
        },
        { status: 409 }
      );
    }

    // Real stored inputs: auditor findings for the 4 quality dims + verbatim
    // PAA questions from the latest SERP snapshot (when one exists).
    const findings = await loadQualityFindings(params.pageId);
    const paaQuestions = await loadPaaQuestions(page.url);

    const headingList = page.headings
      .slice(0, 10)
      .map((h) => `- ${h.text}`)
      .join("\n");

    const findingsBlock = findings.length
      ? `## What the audit found on this page's quality dimensions
${findings.map((f) => `- ${f.dimension}: ${f.rationale}`).join("\n")}
Use the named gaps: a scenario the auditor says is MISSING makes an ideal prompt — it's a question a buyer will ask that this page should win.`
      : "";

    const paaBlock = paaQuestions.length
      ? `## Real People-Also-Ask questions from this page's Google SERP (verbatim)
${paaQuestions.map((q) => `- ${q}`).join("\n")}
Prefer these exact phrasings (or close variants) for impliedQuestions prompts — they are questions real searchers ask.`
      : "";

    const userMessage = `Build the LLM prompt set for ONE web page: the questions a buyer would type into an AI assistant (ChatGPT, Perplexity, Gemini, Claude) that this page should be cited for.

## The page
URL: ${page.url}
Title: ${page.title || "(none)"}
Meta description: ${page.metaDescription || "(none)"}
Main headings:
${headingList || "(none)"}
Opening content: ${page.bodyText.slice(0, 800)}

${findingsBlock}

${paaBlock}

## Your task
Call record_prompt_set with 8–12 prompts mapped to the page's quality dimensions:
- coreIntent (2–3): the direct questions the page's main purpose answers.
- edgeCases (2–3): exceptions, qualifications, "what if" and "does this apply when" questions the topic raises.
- impliedQuestions (2–3): the natural follow-ups a reader asks next.
- fanOutQueries (2–3): adjacent comparisons and related-topic questions a strong answer would branch into.

Hard rules:
- Phrase each prompt the way a real buyer talks to an AI assistant — conversational, first-person where natural, ≤200 characters.
- Ground every prompt in the page's ACTUAL topic and the findings above. Do not invent product claims, numbers, or features.
- Category-level phrasing is fine (buyers rarely name brands); never fabricate a brand comparison.
- No duplicates or trivial rewordings.`;

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 50_000,
      maxRetries: 1,
    });

    const response = await anthropic.messages.create({
      model: GEN_MODEL,
      max_tokens: 2048,
      temperature: 0,
      system:
        "You turn a web page's audited content into the buyer-intent prompt set it should win in AI assistants. You only use the page material provided — you never invent facts — and you always finish by calling the record_prompt_set tool.",
      tools: [RECORD_TOOL],
      tool_choice: { type: "tool", name: "record_prompt_set" },
      messages: [{ role: "user", content: userMessage }],
    });

    await recordAnthropicCall({
      purpose: "prompt_gen",
      model: GEN_MODEL,
      usage: response.usage,
      projectId: bundle.projectId,
      jobId: bundle.jobId,
      pageUrl: page.url,
    });

    const recorded = extractRecordedPrompts(response.content as unknown[]);
    if (recorded.length === 0) {
      return NextResponse.json(
        { error: "Generation returned no prompts — try again" },
        { status: 502 }
      );
    }

    const result = await addGeneratedPrompts(bundle.projectId, page.url, recorded);
    const rows = await getPromptRowsForUrl(bundle.projectId, page.url);
    return NextResponse.json({ ...result, prompts: rows });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/prompt-set POST]`, err);
    return NextResponse.json(
      { error: "Prompt generation failed — please try again" },
      { status: 500 }
    );
  }
}

// ── Stored inputs ─────────────────────────────────────────────

const QUALITY_DIMS: PromptDimension[] = [...PROMPT_DIMENSIONS];

async function loadQualityFindings(
  pageId: string
): Promise<{ dimension: string; rationale: string }[]> {
  if (!process.env.DATABASE_URL) return [];
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT rationale FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return [];
  const rationale = (r.rationale as Record<string, string>) ?? {};
  return QUALITY_DIMS.filter((d) => rationale[d]).map((d) => ({
    dimension: d,
    rationale: rationale[d],
  }));
}

async function loadPaaQuestions(pageUrl: string): Promise<string[]> {
  if (!process.env.DATABASE_URL) return [];
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT q.question FROM serp_questions q
    JOIN serp_snapshots s ON s.id = q.snapshot_id
    WHERE s.page_url = ${pageUrl}
    ORDER BY s.fetched_at DESC
    LIMIT 10
  `.catch(() => [] as Record<string, unknown>[]);
  return rows.map((r) => r.question as string);
}

// ── Record tool ───────────────────────────────────────────────

const RECORD_TOOL = {
  name: "record_prompt_set",
  description:
    "Record the generated buyer-intent prompt set for this page, each prompt mapped to the quality dimension it probes.",
  input_schema: {
    type: "object" as const,
    required: ["prompts"],
    properties: {
      prompts: {
        type: "array",
        minItems: 8,
        maxItems: 12,
        items: {
          type: "object",
          required: ["prompt", "dimension"],
          properties: {
            prompt: {
              type: "string",
              description:
                "The prompt exactly as a buyer would type it to an AI assistant (≤200 chars)",
            },
            dimension: {
              type: "string",
              enum: ["coreIntent", "edgeCases", "impliedQuestions", "fanOutQueries"],
              description: "The quality dimension this prompt probes",
            },
          },
        },
      },
    },
  },
};

function extractRecordedPrompts(
  content: unknown[]
): { prompt: string; dimension: PromptDimension }[] {
  for (let i = content.length - 1; i >= 0; i--) {
    const b = content[i] as { type?: string; name?: string; input?: { prompts?: unknown } };
    if (b?.type === "tool_use" && b?.name === "record_prompt_set") {
      const raw = Array.isArray(b.input?.prompts) ? (b.input!.prompts as unknown[]) : [];
      const out: { prompt: string; dimension: PromptDimension }[] = [];
      for (const item of raw) {
        const p = item as Record<string, unknown>;
        const text = typeof p.prompt === "string" ? p.prompt.trim().slice(0, 300) : "";
        const dim = p.dimension as PromptDimension;
        if (!text || !PROMPT_DIMENSIONS.includes(dim)) continue;
        out.push({ prompt: text, dimension: dim });
        if (out.length >= 12) break;
      }
      return out;
    }
  }
  return [];
}
