// ─────────────────────────────────────────────────────────────
//  /projects/[id]/optimize — the optimization queue.
//  Four crawl-forcing intent-bucket cards (Recency / Ranking /
//  Local / Comparison) filter both lists below on click — the
//  interactive surface lives in components/OptimizeView (client);
//  this server component just loads and serializes the data.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import { getProjectOptimizeStates } from "@/lib/db/drafts";
import OptimizeView from "@/components/OptimizeView";
import type { QueueEntry } from "@/components/OptimizeView";
import { getLatestScores, buildOptimizedRows, buildBucketRollup } from "@/lib/hub";
import { DIMENSION_LABELS, ALL_DIMENSIONS } from "@/lib/types";
import type { IntentBucket } from "@/lib/types";

export const revalidate = 0;

export default async function ProjectOptimizePage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { clientScores, hasResults } = await getLatestScores(params.id);
  const optimizeStates = hasResults ? await getProjectOptimizeStates(params.id) : {};

  // Buckets per URL (classifier output stored on the score rows).
  const bucketsByUrl = new Map<string, IntentBucket[] | null>(
    clientScores.map((s) => [s.url, (s.intentBuckets as IntentBucket[] | null) ?? null])
  );
  const { buckets, unclassified } = buildBucketRollup(clientScores);

  const optimizedRows = buildOptimizedRows(clientScores, optimizeStates).map((r) => ({
    ...r,
    buckets: bucketsByUrl.get(r.url) ?? null,
  }));

  // Work queue: pages with no optimization work yet, weakest first.
  const queue: QueueEntry[] = clientScores
    .filter((s) => !optimizeStates[s.url])
    .sort((a, b) => a.overallScore - b.overallScore)
    .map((s) => ({
      url: s.url,
      pageId: s.pageId,
      grade: s.grade,
      overall: s.overallScore,
      weakest: ALL_DIMENSIONS
        .map((d) => ({ label: DIMENSION_LABELS[d], score: s.scores[d] }))
        .sort((a, b) => a.score - b.score)
        .slice(0, 2),
      buckets: bucketsByUrl.get(s.url) ?? null,
    }));

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Optimize
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          Rewrite, simulate, and re-score pages in the workbench. Simulated scores are engine
          alignment checks — never predicted rankings or citations.
        </p>
      </div>

      {!hasResults ? (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            Nothing to optimize yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            Run your first audit from the{" "}
            <Link href={`/projects/${params.id}`} className="font-semibold hover:underline" style={{ color: "#4f46e5" }}>
              Overview
            </Link>{" "}
            — scored pages queue up here, weakest first.
          </p>
        </div>
      ) : (
        <OptimizeView
          projectId={params.id}
          buckets={buckets}
          unclassified={unclassified}
          optimizedRows={optimizedRows}
          queue={queue}
        />
      )}
    </div>
  );
}
