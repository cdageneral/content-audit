// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/simulate  { draftId }
//
//  Score a saved draft with the EXACT production scoring engine:
//  same model, same prompt version, same weights as the baseline
//  run, temperature 0. The draft is converted to a CrawledPage with
//  crawler-parity formulas (lib/optimize/transform.ts), hashed with
//  computeContentHash, and — if the hash matches any stored score
//  for this URL — the stored score is returned verbatim (reused:
//  true, no model call). That is the repeatability guarantee:
//  publish the draft as-is and the next real audit reproduces the
//  simulated number.
//
//  Results land ONLY in draft_simulations (sandboxed): they never
//  touch page_scores, averages, history, or competitor comparisons.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { findReusableScore } from "@/lib/db/client";
import {
  getDraft,
  getPageForOptimize,
  insertSimulation,
  countRecentSimulations,
} from "@/lib/db/drafts";
import type { TargetCoverage } from "@/lib/db/drafts";
import { draftToCrawledPage } from "@/lib/optimize/transform";
import { getSerpScoringContext } from "@/lib/serp/context";
import { resolveAllTargets } from "@/lib/serp/visibility";
import {
  scorePage,
  computeContentHash,
  SCORING_MODEL,
} from "@/lib/scoring/index";
import { PROMPT_VERSION } from "@/lib/scoring/prompt";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";
import { recordAnthropicCall } from "@/lib/usage/record";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { pageId: string } };

// Client-facing cost control: non-reused simulations are paid model calls.
const DAILY_CAP = parseInt(process.env.OPTIMIZE_SIM_DAILY_CAP ?? "50", 10);

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const draftId = typeof body?.draftId === "string" ? body.draftId : undefined;
    if (!draftId) {
      return NextResponse.json({ error: "draftId is required" }, { status: 400 });
    }
    // Checked visibility targets from the workbench. Validated server-side
    // against the stored SERP snapshot — a client can only select targets
    // that actually exist for this URL.
    const requestedTargets: string[] = Array.isArray(body?.targets)
      ? (body.targets as unknown[])
          .filter((t): t is string => typeof t === "string")
          .slice(0, 12)
      : [];

    const draft = await getDraft(draftId);
    if (!draft || draft.pageId !== params.pageId) {
      return NextResponse.json({ error: "Draft not found for this page" }, { status: 404 });
    }

    const bundle = await getPageForOptimize(params.pageId);
    if (!bundle) {
      return NextResponse.json({ error: "Page not found" }, { status: 404 });
    }

    // Same weights as the baseline run — a delta must reflect the content
    // change alone, never a weighting change.
    const weights: DimensionScores = { ...DEFAULT_WEIGHTS, ...bundle.weights };

    const simPage = draftToCrawledPage(
      bundle.jobId,
      bundle.page.url,
      {
        title: draft.title,
        metaDescription: draft.metaDescription,
        bodyMd: draft.bodyMd,
        metadata: draft.metadata,
        internalLinks: draft.internalLinks,
        externalLinks: draft.externalLinks,
      },
      bundle.page.httpStatus
    );

    // Same verified-SERP context lookup as the production scorer — parity is
    // what makes a simulated number reproducible by the next real audit.
    const serpContext = await getSerpScoringContext(bundle.page.url);
    const contentHash = computeContentHash(simPage, weights, serpContext);

    // Exact-match reuse: unchanged input ⇒ stored score, zero cost, perfect
    // parity (this is also how "simulate without editing" proves the tool
    // reproduces the baseline).
    const reusable = await findReusableScore(bundle.page.url, contentHash);

    // Visibility targets (server-validated). Coverage is a separate small
    // temp-0 call on the draft content — it never touches the scoring engine,
    // the prompt version, or the content hash, and a coverage failure never
    // fails the simulation.
    const resolved = await resolveAllTargets(
      bundle.page.url,
      bundle.projectId,
      requestedTargets
    ).catch(() => ({ serp: [], prompts: [] }));
    // Coverage judges plain target strings — ranked keywords and prompts alike.
    const targets = [
      ...resolved.serp.map((k) => k.keyword),
      ...resolved.prompts,
    ].slice(0, 10);

    let simulation;
    if (reusable) {
      const coverage = await assessTargetCoverage(simPage, targets, {
        projectId: draft.projectId,
        jobId: bundle.jobId,
        pageUrl: bundle.page.url,
      });
      simulation = await insertSimulation({
        draftId: draft.id,
        pageId: draft.pageId,
        projectId: draft.projectId,
        url: bundle.page.url,
        scores: reusable.scores,
        rationale: reusable.rationale,
        evidence: reusable.evidence ?? {},
        recommendations: reusable.recommendations ?? [],
        overallScore: reusable.overallScore,
        grade: reusable.grade,
        modelVersion: reusable.modelVersion,
        promptVersion: PROMPT_VERSION,
        contentHash,
        weights,
        reused: true,
        coverage,
      });
    } else {
      const used = await countRecentSimulations(draft.projectId);
      if (used >= DAILY_CAP) {
        return NextResponse.json(
          {
            error: `Daily simulation limit reached (${DAILY_CAP}/24h for this project). Try again later.`,
          },
          { status: 429 }
        );
      }

      const scored = await scorePage(simPage, params.pageId, weights, contentHash, serpContext, "simulate");
      if (scored.modelVersion === "error") {
        return NextResponse.json(
          { error: "Scoring failed — please try again" },
          { status: 502 }
        );
      }

      const coverage = await assessTargetCoverage(simPage, targets, {
        projectId: draft.projectId,
        jobId: bundle.jobId,
        pageUrl: bundle.page.url,
      });

      simulation = await insertSimulation({
        draftId: draft.id,
        pageId: draft.pageId,
        projectId: draft.projectId,
        url: bundle.page.url,
        scores: scored.scores,
        rationale: scored.rationale,
        evidence: scored.evidence ?? {},
        recommendations: scored.recommendations ?? [],
        overallScore: scored.overallScore,
        grade: scored.grade,
        modelVersion: scored.modelVersion,
        promptVersion: PROMPT_VERSION,
        contentHash,
        weights,
        reused: false,
        coverage,
      });
    }

    return NextResponse.json({
      simulation,
      derived: {
        wordCount: simPage.wordCount,
        headingCount: simPage.headings.length,
        internalLinks: simPage.internalLinks.length,
        externalLinks: simPage.externalLinks.length,
      },
    });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/simulate POST]`, err);
    return NextResponse.json(
      { error: "Simulation failed — please try again" },
      { status: 500 }
    );
  }
}

// ── Target coverage (deterministic content-alignment check) ───
//
// Answers ONE narrow question per target: does the draft substantively
// address this query, with a clear self-contained passage an AI answer
// could quote? It deliberately does NOT predict rankings or citations —
// real outcomes are measured post-publish by the next audit run.
//
// Same window as the scorer (first 12,000 chars of bodyText) so coverage
// never "sees" content the scoring engine can't.

const COVERAGE_WINDOW = 12_000;

const COVERAGE_TOOL = {
  name: "record_target_coverage",
  description: "Record the coverage verdict for every target query, in the order given.",
  input_schema: {
    type: "object" as const,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["target", "status", "note"],
          properties: {
            target: { type: "string", description: "The target query, verbatim as given" },
            status: {
              type: "string",
              enum: ["covered", "partial", "missing"],
              description:
                "covered = a dedicated, self-contained passage directly answers this query; partial = touched on but incomplete or scattered; missing = not substantively addressed",
            },
            note: {
              type: "string",
              description: "One short sentence pointing at the passage (covered/partial) or what's absent (missing). ≤140 chars.",
            },
          },
        },
      },
    },
  },
};

async function assessTargetCoverage(
  simPage: { title: string; metaDescription: string; bodyText: string },
  targets: string[],
  ledger: { projectId: string; jobId: string; pageUrl: string }
): Promise<TargetCoverage[] | null> {
  if (targets.length === 0) return null;
  try {
    const anthropic = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      timeout: 60_000,
      maxRetries: 1,
    });
    const targetList = targets.map((t, i) => `${i + 1}. "${t}"`).join("\n");
    const response = await anthropic.messages.create({
      model: SCORING_MODEL,
      max_tokens: 1024,
      temperature: 0,
      system:
        "You judge whether a draft web page substantively addresses specific search queries. You judge ONLY the text provided — no outside knowledge, no guessing about rankings or AI citations. You always answer by calling the record_target_coverage tool exactly once, with one item per target, in order.",
      tools: [COVERAGE_TOOL],
      tool_choice: { type: "tool", name: "record_target_coverage" },
      messages: [
        {
          role: "user",
          content: `## Target queries\n${targetList}\n\n## Draft page\nTitle: ${simPage.title || "(none)"}\nMeta description: ${simPage.metaDescription || "(none)"}\n\nContent (same window the scoring engine reads):\n${simPage.bodyText.slice(0, COVERAGE_WINDOW)}\n\nFor each target query, judge whether this draft substantively addresses it with a clear, self-contained passage. Record one verdict per target.`,
        },
      ],
    });

    await recordAnthropicCall({
      purpose: "coverage",
      model: SCORING_MODEL,
      usage: response.usage,
      projectId: ledger.projectId,
      jobId: ledger.jobId,
      pageUrl: ledger.pageUrl,
    });

    for (const block of response.content) {
      if (block.type === "tool_use" && block.name === "record_target_coverage") {
        const items = (block.input as { items?: unknown[] })?.items;
        if (!Array.isArray(items)) return null;
        const byTarget = new Map<string, TargetCoverage>();
        for (const raw of items) {
          const it = raw as Record<string, unknown>;
          const target = typeof it.target === "string" ? it.target.trim() : "";
          const status =
            it.status === "covered" || it.status === "partial" || it.status === "missing"
              ? it.status
              : null;
          if (!target || !status) continue;
          byTarget.set(target.toLowerCase(), {
            target,
            status,
            note: typeof it.note === "string" ? it.note.slice(0, 200) : "",
          });
        }
        // Return in the requested target order; a target the model skipped is
        // reported honestly as unassessed rather than silently dropped.
        return targets.map(
          (t) =>
            byTarget.get(t.toLowerCase()) ?? {
              target: t,
              status: "missing" as const,
              note: "Not assessed by the coverage check — re-run Simulate.",
            }
        );
      }
    }
    return null;
  } catch (err) {
    // Coverage must never fail the simulation.
    console.error("[simulate] target coverage failed:", err);
    return null;
  }
}
