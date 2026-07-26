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

export interface SerpRollupView {
  fetchedAt: string;
  database: string;
  pagesWithData: number;
  aioTriggeredKws: number;
  aioCitedKws: number;
  paaPresentKws: number;
  paaOwnedKws: number;
  questionsTotal: number;
  questionsCovered: number;
  citedList: { keyword: string; pageUrl: string }[];
}

export default function SearchVisibilityCard({
  projectId,
  rollup,
  configured,
}: {
  projectId: string;
  rollup: SerpRollupView | null;
  configured: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  // Not configured and nothing stored → stay out of the way entirely.
  if (!configured && !rollup) return null;

  async function fetchSerp() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/serp`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsg(data?.error ?? "Fetch failed — please try again.");
      } else {
        setMsg(
          `Checking ${data.pages} page(s) against Google SERP data — results appear here in a minute or two.`
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
        <button
          onClick={fetchSerp}
          disabled={busy}
          className="text-sm px-3 py-1.5 rounded-md border hover:bg-black/5 disabled:opacity-50"
        >
          {busy ? "Dispatching…" : rollup ? "Refresh SERP data" : "Fetch search visibility"}
        </button>
      </div>

      {msg && <p className="text-sm mt-3 opacity-80">{msg}</p>}

      {rollup && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4">
            <Stat
              label="AI Overview citations"
              value={`${rollup.aioCitedKws} / ${rollup.aioTriggeredKws}`}
              hint="Keywords with an AI Overview where a page of yours is cited, of all your ranked keywords that trigger one (branded excluded)"
              tone={rollup.aioCitedKws > 0 ? "good" : rollup.aioTriggeredKws > 0 ? "warn" : "flat"}
            />
            <Stat
              label="PAA answers owned"
              value={`${rollup.paaOwnedKws} / ${rollup.paaPresentKws}`}
              hint="Keywords where a page of yours is the People-Also-Ask answer source, of those showing a PAA box"
              tone={rollup.paaOwnedKws > 0 ? "good" : rollup.paaPresentKws > 0 ? "warn" : "flat"}
            />
            <Stat
              label="Question coverage"
              value={
                rollup.questionsTotal > 0
                  ? `${rollup.questionsCovered} / ${rollup.questionsTotal}`
                  : "—"
              }
              hint="Question-form queries around each page's primary keyword that the page already ranks for or answers in a heading"
              tone={
                rollup.questionsTotal === 0
                  ? "flat"
                  : rollup.questionsCovered * 2 >= rollup.questionsTotal
                  ? "good"
                  : "warn"
              }
            />
            <Stat
              label="Pages with SERP data"
              value={String(rollup.pagesWithData)}
              hint={`Google ${rollup.database.toUpperCase()} database`}
              tone="flat"
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
    <div className="rounded-lg border border-black/10 p-3" title={hint}>
      <div className="text-lg font-semibold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-xs opacity-60 mt-0.5">{label}</div>
    </div>
  );
}
