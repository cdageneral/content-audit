// ─────────────────────────────────────────────────────────────
//  POST /api/optimize/[pageId]/verify  { draftId, simulationId }
//
//  The credibility closer: after the user publishes their
//  optimized copy for real, re-crawl the live URL and compare it
//  to the simulation.
//
//  - Exact match (live content fingerprint === the simulation's):
//    the real score IS the simulated score, proven with zero model
//    calls — the same determinism guarantee the simulator uses.
//  - Mismatch: score the live page fresh (same engine, temp 0)
//    AND produce a fidelity report showing precisely where the
//    published page differs from the draft (typical culprit: CMS
//    template text inside the main content area).
//
//  Writes ONLY to draft_verifications (sandboxed). Real audit
//  history still only changes through a normal audit run.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import {
  getDraft,
  getSimulation,
  getPageForOptimize,
  insertVerification,
} from "@/lib/db/drafts";
import type { VerificationFidelity } from "@/lib/db/drafts";
import { draftToCrawledPage } from "@/lib/optimize/transform";
import { extractPage } from "@/lib/crawler/extract";
import { scorePage, computeContentHash } from "@/lib/scoring/index";
import { DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

type Params = { params: { pageId: string } };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json().catch(() => ({}));
    const draftId = typeof body?.draftId === "string" ? body.draftId : undefined;
    const simulationId =
      typeof body?.simulationId === "string" ? body.simulationId : undefined;
    if (!draftId || !simulationId) {
      return NextResponse.json(
        { error: "draftId and simulationId are required" },
        { status: 400 }
      );
    }

    const [draft, simulation, bundle] = await Promise.all([
      getDraft(draftId),
      getSimulation(simulationId),
      getPageForOptimize(params.pageId),
    ]);
    if (!draft || draft.pageId !== params.pageId || !bundle) {
      return NextResponse.json({ error: "Draft or page not found" }, { status: 404 });
    }
    if (!simulation || simulation.draftId !== draftId) {
      return NextResponse.json(
        { error: "Simulation not found for this draft — simulate first" },
        { status: 404 }
      );
    }

    // Live crawl of the published page (plain fetch — same first-pass path a
    // real audit uses).
    const live = await extractPage(bundle.jobId, bundle.page.url);
    if (!live || !live.bodyText.trim()) {
      return NextResponse.json(
        { error: "Could not fetch the published page — it may be blocking crawlers or temporarily down" },
        { status: 502 }
      );
    }

    const weights: DimensionScores = { ...DEFAULT_WEIGHTS, ...bundle.weights };
    const liveHash = computeContentHash(live, weights);

    if (liveHash === simulation.contentHash) {
      // Exact fingerprint match: the published page is byte-equivalent (as
      // scoring input) to what was simulated — the simulated score IS the
      // real score. No model call needed; that's the whole point.
      const verification = await insertVerification({
        pageId: params.pageId,
        draftId,
        simulationId,
        projectId: draft.projectId,
        matched: true,
        liveContentHash: liveHash,
        realScores: simulation.scores,
        realOverall: simulation.overallScore,
        realGrade: simulation.grade,
        fidelity: {},
        modelVersion: simulation.modelVersion,
      });
      return NextResponse.json({
        matched: true,
        realOverall: verification.realOverall,
        realGrade: verification.realGrade,
        realScores: verification.realScores,
        simulatedOverall: simulation.overallScore,
        verifiedAt: verification.createdAt.toISOString(),
      });
    }

    // Mismatch: score the live page fresh with the exact production engine,
    // and explain the difference.
    const scored = await scorePage(live, params.pageId, weights, liveHash);

    const draftPage = draftToCrawledPage(
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

    const fidelity = buildFidelity(
      { title: live.title, meta: live.metaDescription, body: live.bodyText, headings: live.headings.map((h) => h.text) },
      { title: draftPage.title, meta: draftPage.metaDescription, body: draftPage.bodyText, headings: draftPage.headings.map((h) => h.text) }
    );

    const verification = await insertVerification({
      pageId: params.pageId,
      draftId,
      simulationId,
      projectId: draft.projectId,
      matched: false,
      liveContentHash: liveHash,
      realScores: scored.scores,
      realOverall: scored.overallScore,
      realGrade: scored.grade,
      fidelity,
      modelVersion: scored.modelVersion,
    });

    return NextResponse.json({
      matched: false,
      realOverall: verification.realOverall,
      realGrade: verification.realGrade,
      realScores: verification.realScores,
      simulatedOverall: simulation.overallScore,
      fidelity,
      verifiedAt: verification.createdAt.toISOString(),
    });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/verify POST]`, err);
    return NextResponse.json({ error: "Verification failed — please try again" }, { status: 500 });
  }
}

// ── Fidelity report ───────────────────────────────────────────

interface Snapshot {
  title: string;
  meta: string;
  body: string;
  headings: string[];
}

function buildFidelity(published: Snapshot, draft: Snapshot): VerificationFidelity {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

  // Word-overlap similarity (bag-of-words intersection / larger set): robust,
  // fast, and honest enough — the sentence diffs below carry the specifics.
  const words = (s: string) => norm(s).split(" ").filter(Boolean);
  const bag = (arr: string[]) => {
    const m = new Map<string, number>();
    for (const w of arr) m.set(w, (m.get(w) ?? 0) + 1);
    return m;
  };
  const pubWords = words(published.body);
  const draftWords = words(draft.body);
  const a = bag(pubWords);
  const b = bag(draftWords);
  let overlap = 0;
  a.forEach((count, w) => {
    overlap += Math.min(count, b.get(w) ?? 0);
  });
  const denom = Math.max(pubWords.length, draftWords.length, 1);
  const matchPct = Math.round((overlap / denom) * 100);

  // Heading set differences (order-insensitive; normalized).
  const pubHeadings = published.headings.map(norm);
  const draftHeadings = draft.headings.map(norm);
  const missingHeadings = draft.headings
    .filter((h) => pubHeadings.indexOf(norm(h)) === -1)
    .slice(0, 5);
  const extraHeadings = published.headings
    .filter((h) => draftHeadings.indexOf(norm(h)) === -1)
    .slice(0, 5);

  // Sentence-level one-sided diffs: first 3 sentences unique to each side.
  const sentences = (s: string) =>
    (s.match(/[^.!?]+[.!?]+/g) ?? [])
      .map((x) => x.trim())
      .filter((x) => x.length >= 30);
  const pubSentSet = new Set(sentences(published.body).map(norm));
  const draftSentSet = new Set(sentences(draft.body).map(norm));
  const publishedNotInDraft = sentences(published.body)
    .filter((s) => !draftSentSet.has(norm(s)))
    .slice(0, 3)
    .map((s) => s.slice(0, 200));
  const draftNotInPublished = sentences(draft.body)
    .filter((s) => !pubSentSet.has(norm(s)))
    .slice(0, 3)
    .map((s) => s.slice(0, 200));

  return {
    matchPct,
    titleMatch: norm(published.title) === norm(draft.title),
    metaMatch: norm(published.meta) === norm(draft.meta),
    missingHeadings,
    extraHeadings,
    publishedNotInDraft,
    draftNotInPublished,
  };
}
