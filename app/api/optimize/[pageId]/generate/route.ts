// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/generate
//  Turn the user's SELECTED research suggestions into one
//  insertable markdown section, with inline citations to the
//  real sources. Returns a proposal only — nothing is saved
//  until the user accepts it into the editor.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { neon } from "@neondatabase/serverless";
import { getPageForOptimize } from "@/lib/db/drafts";
import { SCORING_SYSTEM_PROMPT } from "@/lib/scoring/prompt";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";
import type { ScoreDimension, Recommendation } from "@/lib/types";
import { recordAnthropicCall } from "@/lib/usage/record";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { pageId: string } };

const GENERATE_MODEL =
  process.env.REWRITE_MODEL ?? process.env.SCORING_MODEL ?? "claude-haiku-4-5-20251001";

interface SelectedItem {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
}

const GENERATE_SYSTEM = `You are a senior content editor adding a research-backed section to a web page, optimizing it against a specific LLM-readiness audit rubric.

Hard rules — violating any of these makes the output unusable:
1. Use ONLY the facts present in the provided research items and the page's existing content. NEVER add statistics, dates, prices, quotes, or claims from memory. If a sentence would benefit from data you don't have, write a bracketed placeholder like [ADD: your 2026 pricing] instead of inventing it.
2. Attribute claims to their sources with inline markdown links, e.g. "according to [Google Search Central](https://...)". Use each provided source's exact URL. These citations are the point — they strengthen the page's Citable and Fan-out scores.
3. Match the page's existing voice and register. Write like an experienced human writer: varied sentence lengths, concrete wording, no filler, no formulaic AI patterns ("In today's digital landscape", "It's important to note", "delve", forced parallel triads), and don't default to bullet lists — flowing prose with an occasional list only where it truly fits.
4. Output ONLY one insertable markdown section: start with a single "## " heading, then the content. No preamble, no explanation, no code fences.`;

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const dimension = body.dimension as ScoreDimension | undefined;
    if (!dimension || (ALL_DIMENSIONS as string[]).indexOf(dimension) === -1) {
      return NextResponse.json({ error: "A valid dimension is required" }, { status: 400 });
    }

    const selected = sanitizeSelected(body.selected);
    if (selected.length === 0) {
      return NextResponse.json(
        { error: "Select at least one research suggestion" },
        { status: 400 }
      );
    }

    const title = typeof body.title === "string" ? body.title : "";
    const bodyMd = typeof body.bodyMd === "string" ? body.bodyMd : "";

    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    const items = selected
      .map(
        (s, i) =>
          `${i + 1}. ${s.title}\n   What the source says: ${s.summary}\n   Source: ${s.sourceTitle} — ${s.sourceUrl}`
      )
      .join("\n");

    // The auditor's stored findings: the written section should explicitly
    // close the gaps the auditor named, not just add adjacent material.
    const findings = await loadDimensionFindings(params.pageId, dimension);
    const findingsBlock = findings.rationale || findings.recommendations.length
      ? `## What the audit found on this dimension (close these named gaps first)

${findings.rationale ? `Auditor rationale: ${findings.rationale}` : ""}
${findings.recommendations.map((r) => `Recommendation [${r.priority}]: ${r.suggestion}`).join("\n")}
`
      : "";

    const prompt = `## The audit's scoring rubric (how the page will be graded)

${SCORING_SYSTEM_PROMPT}

## Target dimension to strengthen

${DIMENSION_LABELS[dimension]}

${findingsBlock}

## The page

URL: ${bundle.page.url}
Title: ${title || bundle.page.title || "(none)"}

## Current content (markdown) — for voice and to avoid repeating what's already covered

${bodyMd.slice(0, 20_000) || "(empty)"}

## Selected research items (real, cited — the ONLY outside facts you may use)

${items}

---
Write ONE insertable markdown section (starting with a "## " heading) that weaves these research items into the page to strengthen ${DIMENSION_LABELS[dimension]} without degrading any other dimension. If the audit named specific gaps above, structure the section around closing THOSE first — a gap the auditor named and you closed moves the score; adjacent material doesn't. Cite each source inline per rule 2. Keep it proportionate: roughly 150–350 words unless the items clearly justify more. Do not repeat content the page already covers — extend it.`;

    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 95_000,
      maxRetries: 1,
    });
    // Newer dateless-ID models (claude-sonnet-5+) deprecate the temperature
    // parameter — only send it to dated snapshots, with a retry fallback.
    const reqParams = {
      model: GENERATE_MODEL,
      max_tokens: 4096,
      system: GENERATE_SYSTEM,
      messages: [{ role: "user" as const, content: prompt }],
      ...(supportsTemperature(GENERATE_MODEL) ? { temperature: 0.3 } : {}),
    };
    let response;
    try {
      response = await anthropic.messages.create(reqParams);
    } catch (err) {
      if (isTemperatureRejection(err) && "temperature" in reqParams) {
        const { temperature: _drop, ...rest } = reqParams as { temperature?: number } & typeof reqParams;
        response = await anthropic.messages.create(rest);
      } else {
        throw err;
      }
    }

    await recordAnthropicCall({
      purpose: "generate",
      model: GENERATE_MODEL,
      usage: response.usage,
      projectId: bundle.projectId,
      jobId: bundle.jobId,
      pageUrl: bundle.page.url,
    });

    const markdown = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();

    if (!markdown) {
      return NextResponse.json({ error: "Model returned empty copy" }, { status: 502 });
    }

    return NextResponse.json({ markdown, modelVersion: GENERATE_MODEL });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/generate POST]`, err);
    return NextResponse.json({ error: "Copy generation failed — please try again" }, { status: 500 });
  }
}

// ── Auditor findings for one dimension ────────────────────────

interface DimensionFindings {
  rationale?: string;
  recommendations: Recommendation[];
}

async function loadDimensionFindings(
  pageId: string,
  dimension: ScoreDimension
): Promise<DimensionFindings> {
  const out: DimensionFindings = { recommendations: [] };
  if (!process.env.DATABASE_URL) return out;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT rationale, recommendations FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return out;
  const rationale = (r.rationale as Record<string, string>) ?? {};
  if (rationale[dimension]) out.rationale = rationale[dimension];
  out.recommendations = ((r.recommendations as Recommendation[]) ?? [])
    .filter((rec) => rec.dimension === dimension)
    .slice(0, 4);
  return out;
}

/** Dated snapshots (…-YYYYMMDD) accept temperature; newer dateless IDs deprecate it. */
function supportsTemperature(model: string): boolean {
  return /-\d{8}$/.test(model);
}

function isTemperatureRejection(err: unknown): boolean {
  const e = err as { status?: number; message?: string };
  return e?.status === 400 && String(e?.message ?? "").toLowerCase().includes("temperature");
}

function sanitizeSelected(v: unknown): SelectedItem[] {
  if (!Array.isArray(v)) return [];
  const out: SelectedItem[] = [];
  for (const item of v) {
    const s = item as Record<string, unknown>;
    const title = typeof s.title === "string" ? s.title.trim().slice(0, 120) : "";
    const summary = typeof s.summary === "string" ? s.summary.trim().slice(0, 400) : "";
    const sourceUrl = typeof s.sourceUrl === "string" ? s.sourceUrl.trim() : "";
    const sourceTitle =
      typeof s.sourceTitle === "string" ? s.sourceTitle.trim().slice(0, 160) : "";
    if (!title || !summary || !sourceUrl) continue;
    try {
      const u = new URL(sourceUrl);
      if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    } catch {
      continue;
    }
    out.push({ title, summary, sourceUrl, sourceTitle: sourceTitle || sourceUrl });
    if (out.length >= 6) break;
  }
  return out;
}
