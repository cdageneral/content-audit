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
import { findReusableScore } from "@/lib/db/client";
import {
  getDraft,
  getPageForOptimize,
  insertSimulation,
  countRecentSimulations,
} from "@/lib/db/drafts";
import { draftToCrawledPage } from "@/lib/optimize/transform";
import { getSerpScoringContext } from "@/lib/serp/context";
import {
  scorePage,
  computeContentHash,
  SCORING_MODEL,
} from "@/lib/scoring/index";
import { PROMPT_VERSION } from "@/lib/scoring/prompt";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";

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

    let simulation;
    if (reusable) {
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

      const scored = await scorePage(simPage, params.pageId, weights, contentHash, serpContext);
      if (scored.modelVersion === "error") {
        return NextResponse.json(
          { error: "Scoring failed — please try again" },
          { status: 502 }
        );
      }

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
