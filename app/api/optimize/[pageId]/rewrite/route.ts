// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/rewrite
//  AI rewrite proposal for the optimize workbench. Returns a
//  markdown proposal only — nothing is saved until the user
//  accepts it into the editor and saves a draft themselves.
//
//  The prompt embeds the REAL scoring rubric (the same system
//  prompt the auditor uses) plus this page's stored rationales,
//  evidence quotes, and recommendations, so the rewrite optimizes
//  against the actual grading criteria — not a guess at them.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { getPageForOptimize } from "@/lib/db/drafts";
import { SCORING_SYSTEM_PROMPT } from "@/lib/scoring/prompt";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";
import type { ScoreDimension, Recommendation } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { pageId: string } };

// A stronger writing model can be configured without redeploying; defaults to
// the scoring model, which is guaranteed present.
const REWRITE_MODEL =
  process.env.REWRITE_MODEL ?? process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

const MAX_BODY_CHARS = 60_000;

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const targets = (Array.isArray(body.targetDimensions) ? body.targetDimensions : [])
      .filter((d: unknown): d is ScoreDimension =>
        typeof d === "string" && (ALL_DIMENSIONS as string[]).includes(d)
      )
      .slice(0, 4);
    const title = typeof body.title === "string" ? body.title : "";
    const metaDescription =
      typeof body.metaDescription === "string" ? body.metaDescription : "";
    const bodyMd = typeof body.bodyMd === "string" ? body.bodyMd : "";

    if (targets.length === 0) {
      return NextResponse.json(
        { error: "At least one target dimension is required" },
        { status: 400 }
      );
    }
    if (!bodyMd.trim()) {
      return NextResponse.json({ error: "Content is empty" }, { status: 400 });
    }
    if (bodyMd.length > MAX_BODY_CHARS) {
      return NextResponse.json(
        { error: "Content is too long for an AI rewrite — trim it first" },
        { status: 413 }
      );
    }

    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    // Baseline audit context for the targeted dimensions (server-fetched, so
    // the model optimizes against the authoritative stored audit — not
    // whatever a client chose to send).
    const auditContext = await loadAuditContext(params.pageId, targets);

    const prompt = buildRewritePrompt(
      bundle.page.url,
      title,
      metaDescription,
      bodyMd,
      targets,
      auditContext
    );

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 95_000,
      maxRetries: 1,
    });
    const response = await anthropic.messages.create({
      model: REWRITE_MODEL,
      max_tokens: 8192,
      // Slight temperature: this is writing, not measurement. Determinism
      // matters for SCORING; a rewrite proposal the user reviews does not
      // need to be identical run-to-run.
      temperature: 0.3,
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });

    const markdown = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    if (!markdown) {
      return NextResponse.json({ error: "Model returned an empty rewrite" }, { status: 502 });
    }

    return NextResponse.json({ markdown, modelVersion: REWRITE_MODEL });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/rewrite POST]`, err);
    return NextResponse.json({ error: "Rewrite failed — please try again" }, { status: 500 });
  }
}

// ── Audit context ─────────────────────────────────────────────

interface AuditContext {
  scores: Partial<Record<ScoreDimension, number>>;
  rationale: Partial<Record<ScoreDimension, string>>;
  evidence: Partial<Record<ScoreDimension, string[]>>;
  recommendations: Recommendation[];
}

async function loadAuditContext(
  pageId: string,
  targets: ScoreDimension[]
): Promise<AuditContext> {
  const out: AuditContext = { scores: {}, rationale: {}, evidence: {}, recommendations: [] };
  if (!process.env.DATABASE_URL) return out;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT * FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return out;

  const col: Record<ScoreDimension, string> = {
    coreIntent: "score_core_intent",
    edgeCases: "score_edge_cases",
    impliedQuestions: "score_implied_questions",
    fanOutQueries: "score_fan_out_queries",
    retrievable: "score_retrievable",
    extractable: "score_extractable",
    citable: "score_citable",
    reusable: "score_reusable",
  };
  const rationale = (r.rationale as Record<string, string>) ?? {};
  const evidence = (r.evidence as Record<string, string[]>) ?? {};
  for (const dim of targets) {
    out.scores[dim] = r[col[dim]] as number;
    if (rationale[dim]) out.rationale[dim] = rationale[dim];
    if (evidence[dim]?.length) out.evidence[dim] = evidence[dim];
  }
  out.recommendations = ((r.recommendations as Recommendation[]) ?? []).filter((rec) =>
    targets.includes(rec.dimension)
  );
  return out;
}

// ── Prompts ───────────────────────────────────────────────────

const REWRITE_SYSTEM = `You are a senior content editor improving a web page so it scores higher on a specific LLM-readiness audit. You will be given the audit's exact scoring rubric, the page's current audit findings, and the current content in markdown.

Hard rules — violating any of these makes the output unusable:
1. NEVER invent facts, statistics, dates, prices, quotes, study results, customer names, or sources. Every factual claim in your output must already exist in the provided content, or be clearly generic knowledge with no specific attribution. If a section would benefit from data the content doesn't have, write a bracketed placeholder like [ADD: 2025 pricing from your rate sheet] instead of inventing it.
2. Preserve the page's meaning, offer, and every existing factual claim. You are restructuring and strengthening, not changing what the business says.
3. Keep the author's voice. Match the existing register (formal/casual, first/third person). Write like an experienced human writer: varied sentence lengths, concrete wording, no filler. Avoid formulaic AI patterns — no "In today's digital landscape", "It's important to note", "delve", "unlock", no forced parallel triads, and don't turn flowing prose into wall-to-wall bullet lists.
4. Output ONLY the rewritten page content as markdown (headings with #/##/###, links as [text](url)). No preamble, no explanation of changes, no code fences around the whole document.`;

function buildRewritePrompt(
  url: string,
  title: string,
  metaDescription: string,
  bodyMd: string,
  targets: ScoreDimension[],
  ctx: AuditContext
): string {
  const targetBlocks = targets
    .map((dim) => {
      const lines = [
        `### ${DIMENSION_LABELS[dim]} — current score: ${ctx.scores[dim] ?? "n/a"}`,
      ];
      if (ctx.rationale[dim]) lines.push(`Auditor rationale: ${ctx.rationale[dim]}`);
      for (const q of ctx.evidence[dim] ?? []) {
        lines.push(`Evidence quote from the page: "${q}"`);
      }
      return lines.join("\n");
    })
    .join("\n\n");

  const recs = ctx.recommendations
    .map((r) => `- [${r.priority}] (${DIMENSION_LABELS[r.dimension]}) ${r.suggestion}`)
    .join("\n");

  return `## The audit's scoring rubric (this is exactly how the rewritten page will be graded)

${SCORING_SYSTEM_PROMPT}

## This page's audit findings on the dimensions to improve

${targetBlocks || "(no stored findings — improve against the rubric definitions)"}

## Stored recommendations for these dimensions

${recs || "(none)"}

## The page

URL: ${url}
Title: ${title || "(none)"}
Meta description: ${metaDescription || "(none)"}

## Current content (markdown)

${bodyMd}

---
Rewrite the content to maximally improve the dimension(s): ${targets
    .map((d) => DIMENSION_LABELS[d])
    .join(", ")} — without degrading any other dimension in the rubric. Keep the same overall topic coverage and roughly similar length (within ±30%) unless a target dimension specifically rewards adding coverage (e.g. Edge Cases or Implied Questions may justify new sections). Remember rule 1: no invented specifics — use bracketed [ADD: …] placeholders where real data belongs.`;
}
