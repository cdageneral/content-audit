"use client";

// ─────────────────────────────────────────────────────────────
//  Search Visibility card (hub) — verified AIO/PAA presence for
//  the client's latest run, from live Google SERP data.
//
//  Summary counts only, by design (2026-07-26). The old ranked
//  "biggest misses" table was removed: it displayed Google-Ads
//  volumes, which group close variants so every variant inherits
//  the cluster total (a 20/mo term read 1,000,000). That made
//  both the numbers and the ranking wrong. Per-keyword detail —
//  with volumes only when Semrush-verified — lives in the All
//  Pages drawer and the Optimize workbench.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { useRouter } from "next/navigation";
import InfoTip from "@/components/InfoTip";

export interface SerpRollupView {
  fetchedAt: string;
  database: string;
  urlsWithFeatures: number;
  urlsWithData: number;
  aioTriggeredKws: number;
  aioCitedKws: number;
  paaQuestionsTotal: number;
  paaQuestionsOwned: number;
  citedList: { keyword: string; pageUrl: string }[];
}

/** Roll-up of the LLM Prompt Set (real stored checks only). */
export interface PromptSummaryView {
  /** Active prompts in the project's set. */
  total: number;
  /** Prompts with at least one real (non-error) engine check. */
  checked: number;
  /** …of which at least one engine's answer cites the client's site. */
  cited: number;
  /** …of which the best result is a brand mention without a link. */
  brandOnly: number;
}

/** Whether this run's SERP rows were re-fetched or copied from the cache. */
export interface SerpFreshnessView {
  snapshots: number;
  reused: number;
  allReused: boolean;
  dataFetchedAt: string | null;
}

export default function SearchVisibilityCard({
  projectId,
  rollup,
  promptSummary,
  crawledUrls,
  configured,
  freshness,
}: {
  projectId: string;
  rollup: SerpRollupView | null;
  promptSummary: PromptSummaryView | null;
  /** Client pages crawled in the latest run — the All Pages list below. */
  crawledUrls: number;
  configured: boolean;
  freshness?: SerpFreshnessView | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  // Two-step confirm rather than window.confirm(): a native modal blocks the
  // page, and this action spends real money.
  const [confirmForce, setConfirmForce] = useState(false);

  // Not configured and nothing stored → stay out of the way entirely.
  if (!configured && !rollup) return null;

  async function fetchSerp(force = false) {
    setBusy(true);
    setMsg(null);
    setConfirmForce(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/serp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ force }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error ?? "Fetch failed — please try again.");
      } else {
        setMsg(
          force
            ? `Pulling live Google SERP data for ${data.pages} page(s) — this bills DataForSEO. Results appear here in a minute or two.`
            : `Checking ${data.pages} page(s) against Google SERP data — results appear here in a minute or two.`
        );
        setTimeout(() => router.refresh(), 20000);
      }
    } catch {
      setMsg("Fetch failed — please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="anim-fade-up card p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-[240px]">
          <h2 className="text-base font-semibold">Search Visibility — AI Overviews &amp; People Also Ask</h2>
          <p className="text-sm opacity-70 mt-1">
            Verified Google SERP data: where your pages are cited in AI Overviews and own
            People&nbsp;Also&nbsp;Ask answers — and who wins the ones you don&apos;t.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <button
            onClick={() => fetchSerp(false)}
            disabled={busy}
            className="text-sm px-3 py-1.5 rounded-md border hover:bg-black/5 disabled:opacity-50"
          >
            {busy ? "Dispatching…" : rollup ? "Refresh SERP data" : "Fetch search visibility"}
          </button>
          {/* Force refresh (2026-08-03). "Refresh SERP data" above honours the
              monthly cache — inside the same calendar month it re-copies the
              existing snapshot and nothing on this card can move. This is the
              escape hatch, and it is deliberately the quieter of the two
              because it spends DataForSEO units every time. */}
          {rollup &&
            (confirmForce ? (
              <span className="flex items-center gap-2 text-xs">
                <span style={{ color: "#b45309" }}>
                  Pull live data for {crawledUrls} page{crawledUrls === 1 ? "" : "s"}? Bills DataForSEO.
                </span>
                <button
                  onClick={() => fetchSerp(true)}
                  disabled={busy}
                  className="font-semibold px-2 py-0.5 rounded border disabled:opacity-50"
                  style={{ color: "#b45309", borderColor: "rgba(180,83,9,0.4)" }}
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmForce(false)}
                  className="opacity-60 hover:opacity-100"
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                onClick={() => setConfirmForce(true)}
                disabled={busy}
                className="text-xs opacity-60 hover:opacity-100 hover:underline disabled:opacity-40"
                title="Skip the monthly cache and re-pull live Google data (costs DataForSEO units)"
              >
                Force live refresh
              </button>
            ))}
        </div>
      </div>

      {msg && <p className="text-sm mt-3 opacity-80">{msg}</p>}

      {/* Cache state, stated plainly. Without this line an unchanged set of
          numbers after a re-run reads as a measured result rather than a
          copy of the last fetch. */}
      {rollup && freshness?.allReused && (
        <p className="text-xs mt-3" style={{ color: "#b45309" }}>
          These figures were <span className="font-semibold">not re-fetched</span> on the latest
          run — all {freshness.snapshots} page snapshot
          {freshness.snapshots === 1 ? " was" : "s were"} reused from the
          {freshness.dataFetchedAt
            ? ` ${new Date(freshness.dataFetchedAt).toLocaleDateString()} `
            : " earlier "}
          pull. SERP data refreshes once per calendar month to control API spend; use{" "}
          <span className="font-semibold">Force live refresh</span> to override.
        </p>
      )}

      {rollup && (
        <>
          {/* Every card reads acquired / triggered, scoped to this project's
              URLs (2026-07-26). Question coverage was removed — it mixed a
              live-SERP fact with a heading-match content check, which is the
              workbench's job, not a visibility scoreboard's. */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <Stat
              label="AI Overview citations"
              value={`${rollup.aioCitedKws} / ${rollup.aioTriggeredKws}`}
              hint="AI Overviews citing one of your URLs, of all AI Overviews triggered by your ranked keywords (branded excluded)"
              tone={rollup.aioCitedKws > 0 ? "good" : rollup.aioTriggeredKws > 0 ? "warn" : "flat"}
            />
            <Stat
              label="PAA answers owned"
              value={
                rollup.paaQuestionsTotal > 0
                  ? `${rollup.paaQuestionsOwned} / ${rollup.paaQuestionsTotal}`
                  : "—"
              }
              hint={
                rollup.paaQuestionsTotal > 0
                  ? "People-Also-Ask questions where Google names one of your URLs as the answer source, of all PAA questions captured from live SERP scrapes of your pages' top ranked keywords"
                  : "No PAA questions captured yet — run Refresh SERP data to scrape live People-Also-Ask boxes for your ranked keywords"
              }
              tone={
                rollup.paaQuestionsTotal === 0
                  ? "flat"
                  : rollup.paaQuestionsOwned > 0
                  ? "good"
                  : "warn"
              }
            />
            <Stat
              label="LLM prompts cited"
              value={
                promptSummary && promptSummary.checked > 0
                  ? `${promptSummary.cited} / ${promptSummary.checked}`
                  : "—"
              }
              hint={
                promptSummary && promptSummary.total > 0
                  ? `Prompts where at least one engine's answer cites your site, of ${promptSummary.checked} checked (${promptSummary.total} in the set${
                      promptSummary.brandOnly > 0
                        ? `; ${promptSummary.brandOnly} more get a brand mention without a link`
                        : ""
                    }). Real per-engine checks only.`
                  : "No prompt checks run yet — each page's prompts are managed on its Optimize workbench (Search & AI Visibility → Details)"
              }
              tone={
                !promptSummary || promptSummary.checked === 0
                  ? "flat"
                  : promptSummary.cited > 0
                  ? "good"
                  : "warn"
              }
            />
            <Stat
              label="URLs with SERP features"
              value={
                crawledUrls > 0 ? `${rollup.urlsWithFeatures} / ${crawledUrls}` : "—"
              }
              hint={`Pages with at least one ranked keyword that triggers an AI Overview or a People-Also-Ask box, of the ${crawledUrls} crawled pages listed below. Google ${rollup.database.toUpperCase()} database${
                rollup.urlsWithData < crawledUrls
                  ? ` · ${crawledUrls - rollup.urlsWithData} page(s) have no SERP snapshot yet`
                  : ""
              }`}
              tone={rollup.urlsWithFeatures > 0 ? "flat" : "warn"}
            />
          </div>

          {rollup.citedList.length > 0 && (
            <p className="text-xs opacity-60 mt-4">
              Already cited in AI Overviews for:{" "}
              {rollup.citedList
                .slice(0, 5)
                .map((c) => c.keyword)
                .join(" · ")}
              {rollup.citedList.length > 5 ? ` · +${rollup.citedList.length - 5} more` : ""}
            </p>
          )}

          <p className="text-xs opacity-50 mt-3">
            Verified as of {new Date(rollup.fetchedAt).toLocaleDateString()} · Google{" "}
            {rollup.database.toUpperCase()} SERP data · per-URL detail in the All Pages
            table (AI SERP column — click a row)
          </p>
        </>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint: string;
  tone: "good" | "warn" | "flat";
}) {
  const color =
    tone === "good" ? "#16a34a" : tone === "warn" ? "#d97706" : "inherit";
  return (
    // The explanation lives behind a click-to-open ⓘ rather than a native
    // title tooltip: these counts are easy to misread (each is acquired vs
    // triggered), and a hover-only hint is invisible on touch.
    <div className="relative rounded-lg border border-black/10 p-3">
      {/* ⓘ pinned to the card's upper-right. Deliberately NOT inside the
          label row: the label carries opacity-60, and an opacity-reduced
          ancestor makes the whole popover translucent (page text bleeds
          through it). */}
      <span className="absolute top-2 right-2">
        <InfoTip title={label} text={hint} />
      </span>
      <div className="text-lg font-semibold tabular-nums pr-6" style={{ color }}>
        {value}
      </div>
      <div className="text-xs opacity-60 mt-0.5">{label}</div>
    </div>
  );
}
