// ─────────────────────────────────────────────────────────────
//  POST /api/projects/[id]/gap-brief
//  "Explain the gap" — compares the stored evidence (dimension
//  scores, rationales, evidence quotes, recommendations) for the
//  client vs one competitor on ONE dimension and returns a short
//  comparative brief written by Claude.
//
//  Cost control: the result is cached in gap_briefs keyed on the
//  exact pair of audit runs, so each (competitor, dimension) costs
//  ONE model call per run pair — reopening is a pure DB read. A new
//  audit run changes the job ids, which naturally invalidates.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { getScoresByJob, ensureSchemaPatches } from "@/lib/db/client";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";
import type { PageScore, ScoreDimension } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { id: string } };

const BRIEF_MODEL = process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: required so Next's Data Cache can't serve stale reads through
  // the Neon driver's fetch (see lib/db/client.ts getDb).
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const competitorId = body?.competitorId as string | undefined;
    const dimension = body?.dimension as ScoreDimension | undefined;

    if (!competitorId || !dimension || !ALL_DIMENSIONS.includes(dimension)) {
      return NextResponse.json(
        { error: "competitorId and a valid dimension are required" },
        { status: 400 }
      );
    }

    const sql = db();

    // Latest completed run for the client and for this competitor.
    const jobs = await sql`
      SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
        id, competitor_id
      FROM audit_jobs
      WHERE project_id = ${params.id}
        AND status = 'done'
        AND (competitor_id IS NULL OR competitor_id = ${competitorId})
      ORDER BY COALESCE(competitor_id::text, 'client'), completed_at DESC
    `;
    const clientJobId = jobs.find((j) => !j.competitor_id)?.id as string | undefined;
    const competitorJobId = jobs.find((j) => j.competitor_id)?.id as string | undefined;

    if (!clientJobId || !competitorJobId) {
      return NextResponse.json(
        { error: "Both the client and this competitor need a completed audit run first" },
        { status: 409 }
      );
    }

    await ensureSchemaPatches();

    // Cache hit? (keyed on the exact run pair)
    const cached = await sql`
      SELECT brief, model_version, created_at FROM gap_briefs
      WHERE project_id = ${params.id}
        AND competitor_id = ${competitorId}
        AND dimension = ${dimension}
        AND client_job_id = ${clientJobId}
        AND competitor_job_id = ${competitorJobId}
      LIMIT 1
    `;
    if (cached[0]) {
      return NextResponse.json({
        brief: cached[0].brief as string,
        cached: true,
        modelVersion: cached[0].model_version as string,
        generatedAt: cached[0].created_at,
      });
    }

    // Competitor display name for the prompt
    const compRows = await sql`
      SELECT name FROM competitor_configs WHERE id = ${competitorId}
    `;
    const competitorName = (compRows[0]?.name as string) ?? "the competitor";
    const projRows = await sql`
      SELECT client_name FROM projects WHERE id = ${params.id}
    `;
    const clientName = (projRows[0]?.client_name as string) ?? "the client";

    const [clientScores, competitorScores] = await Promise.all([
      getScoresByJob(clientJobId),
      getScoresByJob(competitorJobId),
    ]);
    if (!clientScores.length || !competitorScores.length) {
      return NextResponse.json(
        { error: "No stored scores found for one of the runs" },
        { status: 409 }
      );
    }

    const prompt = buildGapPrompt(
      dimension,
      clientName,
      clientScores,
      competitorName,
      competitorScores
    );

    // 25s timeout × (1 try + 1 retry) stays safely inside maxDuration=60 so
    // Vercel never kills the function mid-retry (which would surface a raw
    // 504 to the drawer instead of our JSON error).
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 25_000,
      maxRetries: 1,
    });
    const response = await anthropic.messages.create({
      model: BRIEF_MODEL,
      max_tokens: 1200,
      messages: [{ role: "user", content: prompt }],
    });
    const brief = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    if (!brief) {
      return NextResponse.json({ error: "Model returned an empty brief" }, { status: 502 });
    }

    // Cache (best-effort — a race between two clicks just double-writes; the
    // unique constraint makes the second insert a no-op via ON CONFLICT).
    await sql`
      INSERT INTO gap_briefs (
        project_id, competitor_id, dimension,
        client_job_id, competitor_job_id, brief, model_version
      ) VALUES (
        ${params.id}, ${competitorId}, ${dimension},
        ${clientJobId}, ${competitorJobId}, ${brief}, ${BRIEF_MODEL}
      )
      ON CONFLICT (project_id, competitor_id, dimension, client_job_id, competitor_job_id)
      DO NOTHING
    `.catch((err) => console.error("[gap-brief] cache write failed:", err));

    return NextResponse.json({ brief, cached: false, modelVersion: BRIEF_MODEL });
  } catch (err) {
    console.error(`[api/projects/${params.id}/gap-brief POST]`, err);
    return NextResponse.json({ error: "Failed to generate gap brief" }, { status: 500 });
  }
}

// ── Prompt builder ────────────────────────────────────────────

function pageBlock(p: PageScore, dim: ScoreDimension): string {
  const quotes = p.evidence?.[dim] ?? [];
  return [
    `- ${p.url} — ${DIMENSION_LABELS[dim]} score ${p.scores[dim]}`,
    p.rationale?.[dim] ? `  Rationale: ${p.rationale[dim]}` : null,
    ...quotes.map((q) => `  Quote from page: "${q}"`),
  ]
    .filter(Boolean)
    .join("\n");
}

function buildGapPrompt(
  dim: ScoreDimension,
  clientName: string,
  clientScores: PageScore[],
  competitorName: string,
  competitorScores: PageScore[]
): string {
  const avg = (arr: PageScore[]) =>
    Math.round(arr.reduce((s, p) => s + p.scores[dim], 0) / arr.length);

  const compTop = [...competitorScores]
    .sort((a, b) => b.scores[dim] - a.scores[dim])
    .slice(0, 6);
  const clientAll = [...clientScores].sort((a, b) => a.scores[dim] - b.scores[dim]);
  const clientWeak = clientAll.slice(0, 6);
  const clientBest = clientAll.slice(-2).reverse();

  const recs = clientScores
    .flatMap((p) => p.recommendations ?? [])
    .filter((r) => r.dimension === dim)
    .slice(0, 8)
    .map((r) => `- [${r.priority}] ${r.suggestion}`)
    .join("\n");

  return `You are a content strategy analyst. Two websites were audited for LLM readiness by the same scoring system. Explain the gap between them on ONE dimension using ONLY the audit data below — do not invent facts, page features, or numbers not present in the data. Where you cite a count, it must be countable from the data provided.

Dimension: ${DIMENSION_LABELS[dim]}
${competitorName} average: ${avg(competitorScores)} (${competitorScores.length} pages)
${clientName} average: ${avg(clientScores)} (${clientScores.length} pages)

## ${competitorName} — top pages on this dimension
${compTop.map((p) => pageBlock(p, dim)).join("\n")}

## ${clientName} — weakest pages on this dimension
${clientWeak.map((p) => pageBlock(p, dim)).join("\n")}

## ${clientName} — strongest pages on this dimension (for contrast)
${clientBest.map((p) => pageBlock(p, dim)).join("\n")}

## Stored recommendations already generated for ${clientName} on this dimension
${recs || "(none)"}

Write a concise gap brief for the ${clientName} team:
1. One-sentence headline: the core structural difference driving the gap (or, if ${clientName} leads, what protects that lead).
2. The 2–3 concrete things ${competitorName} does on this dimension that ${clientName} doesn't (or does worse), each grounded in the rationales/quotes above.
3. The fastest path to close the gap — prioritize template-level or sitewide fixes over page rewrites when the data supports it, and name which of ${clientName}'s listed pages to fix first.

Plain text only (no markdown headers or bold). Use a numbered list for section 2. Keep it under 250 words. If the data is too thin to support a claim, say so rather than guessing.`;
}
