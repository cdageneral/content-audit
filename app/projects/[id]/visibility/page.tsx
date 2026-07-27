// ─────────────────────────────────────────────────────────────
//  /projects/[id]/visibility — AI Visibility section.
//  Project-level roll-up (SearchVisibilityCard: AIO / PAA / LLM
//  prompts) plus a per-page breakdown table. Per the URL-level
//  model (2026-07-26): prompt MANAGEMENT lives on each page's
//  Optimize workbench — this surface is read-only roll-up.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProjectDetail } from "@/lib/db/projects";
import SearchVisibilityCard from "@/components/SearchVisibilityCard";
import { getSerpRollup, getLatestSerpJobId, getSerpPageSummaries } from "@/lib/db/serp";
import { getPromptRows } from "@/lib/db/prompts";
import { serpConfigured } from "@/lib/serp/semrush";
import { dfsConfigured } from "@/lib/serp/dataforseo";
import { getLatestScores } from "@/lib/hub";

export const revalidate = 0;

export default async function ProjectVisibilityPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProjectDetail(params.id).catch(() => null);
  if (!project) return notFound();

  const { clientScores, hasResults } = await getLatestScores(params.id);
  const serpEnabled = serpConfigured() || dfsConfigured();

  let serpRollup = null as Awaited<ReturnType<typeof getSerpRollup>>;
  let serpSummaries: Awaited<ReturnType<typeof getSerpPageSummaries>> | undefined;
  const serpJobId = await getLatestSerpJobId(params.id).catch(() => null);
  if (serpJobId) {
    serpRollup = await getSerpRollup(serpJobId).catch(() => null);
    serpSummaries = await getSerpPageSummaries(serpJobId).catch(() => undefined);
  }

  const promptRows = await getPromptRows(params.id).catch(() => []);
  const promptSummary = (() => {
    if (promptRows.length === 0) return null;
    let checked = 0;
    let cited = 0;
    let brandOnly = 0;
    for (const r of promptRows) {
      const ok = Object.values(r.checks).filter((c) => c && c.status === "ok");
      if (ok.length === 0) continue;
      checked++;
      if (ok.some((c) => c!.cited)) cited++;
      else if (ok.some((c) => c!.brandMentioned)) brandOnly++;
    }
    return { total: promptRows.length, checked, cited, brandOnly };
  })();

  // Per-page rows: pair each audited page with its SERP summary (if any).
  const pageRows = clientScores
    .map((s) => ({ score: s, sum: serpSummaries?.[s.url] }))
    .sort((a, b) => {
      const aMiss = (a.sum?.aioTriggered ?? 0) - (a.sum?.aioCited ?? 0) + (a.sum?.paaPresent ?? 0) - (a.sum?.paaOwned ?? 0);
      const bMiss = (b.sum?.aioTriggered ?? 0) - (b.sum?.aioCited ?? 0) + (b.sum?.paaPresent ?? 0) - (b.sum?.paaOwned ?? 0);
      return bMiss - aMiss; // biggest visibility gaps first
    });

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-6">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          AI Visibility
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          Where your pages stand in Google AI Overviews, People Also Ask, and LLM answers. Per-page
          keyword detail and prompt management live on each page&apos;s Optimize workbench.
        </p>
      </div>

      {hasResults ? (
        <>
          <SearchVisibilityCard
            projectId={params.id}
            rollup={serpRollup}
            promptSummary={promptSummary}
            crawledUrls={clientScores.length}
            configured={serpEnabled}
          />

          {serpSummaries && Object.keys(serpSummaries).length > 0 && (
            <div className="anim-fade-up stagger-2 card overflow-hidden">
              <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
                <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                  Per-page visibility
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>
                  Sorted by biggest gap — AI features triggering on a page&apos;s keywords without citing it.
                </p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-[12.5px]">
                  <thead>
                    <tr style={{ background: "var(--bg-2)" }}>
                      <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-4 py-2.5" style={{ color: "var(--text-3)" }}>Page</th>
                      <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: "var(--text-3)" }}>Head term</th>
                      <th className="text-right font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: "var(--text-3)" }}>AIO cited / triggered</th>
                      <th className="text-right font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: "var(--text-3)" }}>PAA owned / present</th>
                      <th className="px-4 py-2.5"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map(({ score, sum }) => (
                      <tr key={score.pageId} style={{ borderTop: "1px solid var(--border)" }}>
                        <td className="px-4 py-2.5 max-w-[340px] truncate font-medium" style={{ color: "var(--text-1)" }} title={score.url}>
                          {pathOf(score.url)}
                        </td>
                        <td className="px-3 py-2.5" style={{ color: "var(--text-2)" }}>
                          {sum?.primaryKeyword ?? "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right" style={{ color: sum && sum.aioTriggered > 0 && sum.aioCited === 0 ? "#dc2626" : "var(--text-2)" }}>
                          {sum ? `${sum.aioCited} / ${sum.aioTriggered}` : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right" style={{ color: sum && sum.paaPresent > 0 && sum.paaOwned === 0 ? "#dc2626" : "var(--text-2)" }}>
                          {sum ? `${sum.paaOwned} / ${sum.paaPresent}` : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right whitespace-nowrap">
                          <Link
                            href={`/projects/${params.id}/optimize/${score.pageId}`}
                            className="text-xs font-semibold hover:underline"
                            style={{ color: "#4f46e5" }}
                          >
                            Open workbench →
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="anim-fade-up card p-8 text-center">
          <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
            No visibility data yet
          </p>
          <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
            {serpEnabled
              ? "Search visibility is pulled automatically with each audit run — start one from the Overview."
              : "Search visibility isn't configured. Add a DataForSEO or Semrush key, then re-run the audit."}
          </p>
        </div>
      )}
    </div>
  );
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}
