// ─────────────────────────────────────────────────────────────
//  /projects/[id]/optimize/[pageId] — Optimize workbench page.
//  Server component: loads the crawled page, its baseline score,
//  drafts + latest simulations, and the competitor benchmark, then
//  hands everything to the client workbench.
// ─────────────────────────────────────────────────────────────

import { notFound } from "next/navigation";
import { neon } from "@neondatabase/serverless";
import {
  getPageForOptimize,
  getDraftsByPage,
  getSimulationsByPage,
} from "@/lib/db/drafts";
import { getProjectDetail } from "@/lib/db/projects";
import {
  seedMarkdownFromPage,
  pageMetadataFromStored,
} from "@/lib/optimize/transform";
import { SCORING_MODEL } from "@/lib/scoring/index";
import { PROMPT_VERSION } from "@/lib/scoring/prompt";
import OptimizeWorkbench from "@/components/OptimizeWorkbench";
import type {
  WorkbenchBaseline,
  WorkbenchDraft,
  WorkbenchSimulation,
} from "@/components/OptimizeWorkbench";
import type {
  DimensionScores,
  DimensionRationale,
  DimensionEvidence,
  Recommendation,
} from "@/lib/types";

export const revalidate = 0;

export default async function OptimizePage({
  params,
}: {
  params: { id: string; pageId: string };
}) {
  const [bundle, project] = await Promise.all([
    getPageForOptimize(params.pageId).catch(() => null),
    getProjectDetail(params.id).catch(() => null),
  ]);
  if (!bundle || !project) return notFound();
  // Only client pages are optimizable, and only within their own project.
  if (bundle.projectId && bundle.projectId !== params.id) return notFound();

  const baseline = await loadBaseline(params.pageId);

  const [drafts, sims] = await Promise.all([
    getDraftsByPage(params.pageId).catch(() => []),
    getSimulationsByPage(params.pageId).catch(() => []),
  ]);

  // Benchmark: strongest competitor's latest cached overall score.
  let benchmark: { name: string; score: number } | null = null;
  for (const c of project.competitors) {
    if (c.latestScore != null && (!benchmark || c.latestScore > benchmark.score)) {
      benchmark = { name: c.name, score: c.latestScore };
    }
  }

  const seed = {
    title: bundle.page.title,
    metaDescription: bundle.page.metaDescription,
    bodyMd: seedMarkdownFromPage(bundle.page),
    metadata: pageMetadataFromStored(bundle.page),
    internalLinks: bundle.page.internalLinks,
    externalLinks: bundle.page.externalLinks,
  };

  const serializedDrafts: WorkbenchDraft[] = drafts.map((d) => ({
    id: d.id,
    version: d.version,
    title: d.title,
    metaDescription: d.metaDescription,
    bodyMd: d.bodyMd,
    metadata: d.metadata,
    internalLinks: d.internalLinks,
    externalLinks: d.externalLinks,
    createdAt: d.createdAt.toISOString(),
  }));

  const serializedSims: WorkbenchSimulation[] = sims.map((s) => ({
    id: s.id,
    draftId: s.draftId,
    scores: s.scores,
    rationale: s.rationale,
    overallScore: s.overallScore,
    grade: s.grade,
    modelVersion: s.modelVersion,
    promptVersion: s.promptVersion,
    reused: s.reused,
    createdAt: s.createdAt.toISOString(),
  }));

  return (
    <OptimizeWorkbench
      projectId={params.id}
      projectName={project.clientName}
      pageId={params.pageId}
      url={bundle.page.url}
      baseline={baseline}
      benchmark={benchmark}
      seed={seed}
      drafts={serializedDrafts}
      simulations={serializedSims}
      promptVersion={PROMPT_VERSION}
      scoringModel={SCORING_MODEL}
    />
  );
}

// ── Baseline score (latest real score row for this page) ──────

async function loadBaseline(pageId: string): Promise<WorkbenchBaseline | null> {
  if (!process.env.DATABASE_URL) return null;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT * FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC
    LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return null;
  const scores: DimensionScores = {
    coreIntent: r.score_core_intent as number,
    edgeCases: r.score_edge_cases as number,
    impliedQuestions: r.score_implied_questions as number,
    fanOutQueries: r.score_fan_out_queries as number,
    retrievable: r.score_retrievable as number,
    extractable: r.score_extractable as number,
    citable: r.score_citable as number,
    reusable: r.score_reusable as number,
    aioReadiness: (r.score_aio_readiness as number) ?? 0,
    paaCoverage: (r.score_paa_coverage as number) ?? 0,
  };
  return {
    scores,
    rationale: (r.rationale as DimensionRationale) ?? ({} as DimensionRationale),
    evidence: (r.evidence as DimensionEvidence) ?? {},
    recommendations: (r.recommendations as Recommendation[]) ?? [],
    overallScore: r.overall_score as number,
    grade: r.grade as WorkbenchBaseline["grade"],
    modelVersion: r.model_version as string,
    scoredAt: new Date(r.scored_at as string).toISOString(),
    contentHash: (r.content_hash as string | null) ?? null,
  };
}
