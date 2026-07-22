"use client";

// ─────────────────────────────────────────────────────────────
//  Search Visibility card (hub) — verified AIO/PAA presence for
//  the client's latest run, from Semrush SERP data. Headline
//  counts + the "money list": keywords whose SERP shows an AI
//  Overview the client is NOT cited in, sorted by volume.
//  Every number here is verified SERP data — nothing modeled.
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
  moneyList: { keyword: string; volume: number; position: number; pageUrl: string }[];
  citedList: { keyword: string; volume: number; pageUrl: string }[];
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

  const shortUrl = (u: string) => {
    try {
      const p = new URL(u);
      return p.pathname === "/" ? p.hostname : p.pathname;
    } catch {
      return u;
    }
  };

  return (
    <div className="anim-fade-up card p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-[240px]">
          <h2 className="text-base font-semibold">Search Visibility — AI Overviews &amp; People Also Ask</h2>
          <p className="text-sm opacity-70 mt-1">
            Verified Google SERP data (Semrush): where your pages are cited in AI Overviews and
            own People&nbsp;Also&nbsp;Ask answers.
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

          {rollup.moneyList.length > 0 && (
            <div className="mt-5">
              <h3 className="text-sm font-semibold">
                Biggest misses — AI Overview shows, you&apos;re not in it
              </h3>
              <p className="text-xs opacity-60 mt-0.5">
                These searches display an AI Overview and a page of yours ranks — but isn&apos;t
                cited in the answer. Highest search volume first.
              </p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left opacity-60">
                      <th className="py-1.5 pr-3 font-medium">Keyword</th>
                      <th className="py-1.5 pr-3 font-medium">Vol/mo</th>
                      <th className="py-1.5 pr-3 font-medium">Your rank</th>
                      <th className="py-1.5 font-medium">Page</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rollup.moneyList.slice(0, 10).map((m) => (
                      <tr key={`${m.keyword}-${m.pageUrl}`} className="border-t border-black/5">
                        <td className="py-1.5 pr-3">{m.keyword}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{m.volume.toLocaleString()}</td>
                        <td className="py-1.5 pr-3 tabular-nums">#{m.position}</td>
                        <td className="py-1.5 opacity-70 truncate max-w-[260px]" title={m.pageUrl}>
                          {shortUrl(m.pageUrl)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {rollup.citedList.length > 0 && (
            <p className="text-xs opacity-60 mt-4">
              Already cited in AI Overviews for:{" "}
              {rollup.citedList
                .slice(0, 5)
                .map((c) => `${c.keyword} (${c.volume.toLocaleString()}/mo)`)
                .join(" · ")}
              {rollup.citedList.length > 5 ? ` · +${rollup.citedList.length - 5} more` : ""}
            </p>
          )}

          <p className="text-xs opacity-50 mt-3">
            Verified as of {new Date(rollup.fetchedAt).toLocaleDateString()} · Semrush Google{" "}
            {rollup.database.toUpperCase()} data (refreshes ~monthly) · questions are
            question-form search queries, not literal PAA box text
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
