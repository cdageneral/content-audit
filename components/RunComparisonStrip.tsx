// ─────────────────────────────────────────────────────────────
//  "What changed" strip (2026-08-03)
//
//  Answers the question a re-run leaves hanging: did anything
//  actually move? Everything here comes from stored scores — no
//  API call, no model call.
//
//  Honesty rules baked into the copy:
//   • Scoring is deterministic (temperature 0 + content_hash
//     reuse), so "unchanged" is a measured result. The strip says
//     so rather than staying silent, because silence reads as
//     "we didn't check".
//   • When the crawl found or lost pages, the headline average and
//     the like-for-like average are reported separately — a moved
//     average with a changed page set is not a content result.
//   • SERP/AI-Overview data is on a monthly cache. When this run
//     reused it, the strip says the data wasn't re-fetched instead
//     of implying the numbers held steady.
//
//  Server component by design — no state, no effects.
// ─────────────────────────────────────────────────────────────

import Link from "next/link";
import InfoTip from "@/components/InfoTip";
import type { RunComparison } from "@/lib/hub";

const UP = "#059669";
const DOWN = "#dc2626";

function shortDate(d: Date | null): string {
  if (!d) return "the previous scan";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === "/" ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

function Delta({ value, suffix }: { value: number; suffix?: string }) {
  if (value === 0) {
    return (
      <span className="font-semibold" style={{ color: "var(--text-3)" }}>
        no change
      </span>
    );
  }
  return (
    <span className="font-bold tabular-nums" style={{ color: value > 0 ? UP : DOWN }}>
      {value > 0 ? `▲${value}` : `▼${Math.abs(value)}`}
      {suffix ? ` ${suffix}` : ""}
    </span>
  );
}

export default function RunComparisonStrip({
  projectId,
  comparison,
  /** Overall score exactly as the ring renders it, so the two agree. */
  currentOverall,
  /** SERP data for this run was copied from an earlier fetch, not re-pulled. */
  serpReused,
  serpFetchedAt,
}: {
  projectId: string;
  comparison: RunComparison;
  currentOverall: number;
  serpReused: boolean;
  serpFetchedAt: string | null;
}) {
  const c = comparison;
  const headline = currentOverall - c.prevAvg;
  const pageSetChanged = c.added > 0 || c.dropped > 0;
  const nothingMoved = c.improved === 0 && c.declined === 0;

  // `relative z-20` is load-bearing: every card below carries
  // .anim-fade-up, whose lingering transform makes it a stacking context,
  // so an InfoTip popover here would otherwise paint underneath them.
  return (
    <div className="anim-fade-up relative z-20 card px-5 py-4">
      <div className="flex items-start justify-between gap-5 flex-wrap">
        {/* basis + flex-1: the summary column shrinks so "Biggest moves" can sit
            beside it on wide screens instead of always wrapping underneath. */}
        <div className="min-w-0 flex-1 basis-[430px]">
          <p className="text-sm font-semibold flex items-center gap-1.5" style={{ color: "var(--text-1)" }}>
            What changed since {shortDate(c.prevRunAt)}
            <InfoTip
              title="What changed"
              text="Compares this run against your previous completed run, page by page, matching pages by URL. Scoring is deterministic — an unchanged page reproduces its exact prior score — so a page shown as unchanged really did score the same, it wasn't skipped. Pages added or dropped by the crawl are reported separately from score movement, because a shifting page set moves the average on its own."
            />
          </p>

          <p className="text-[13px] mt-1.5 leading-relaxed" style={{ color: "var(--text-2)" }}>
            <span className="font-semibold" style={{ color: "var(--text-1)" }}>Overall</span>{" "}
            <span className="tabular-nums">{c.prevAvg} → {currentOverall}</span>{" "}
            <Delta value={headline} />
            {c.compared > 0 && (
              <>
                {" · "}
                {c.improved > 0 && (
                  <span className="font-semibold" style={{ color: UP }}>
                    {c.improved} page{c.improved === 1 ? "" : "s"} improved
                  </span>
                )}
                {c.improved > 0 && c.declined > 0 && " · "}
                {c.declined > 0 && (
                  <span className="font-semibold" style={{ color: DOWN }}>
                    {c.declined} declined
                  </span>
                )}
                {(c.improved > 0 || c.declined > 0) && c.unchanged > 0 && " · "}
                {c.unchanged > 0 && <>{c.unchanged} unchanged</>}
              </>
            )}
          </p>

          {/* A changed page set moves the average without any page moving.
              Say that plainly rather than letting the headline imply work. */}
          {pageSetChanged && (
            <p className="text-xs mt-1.5" style={{ color: "var(--text-3)" }}>
              Page set changed:
              {c.added > 0 && ` ${c.added} new page${c.added === 1 ? "" : "s"} crawled`}
              {c.added > 0 && c.dropped > 0 && " ·"}
              {c.dropped > 0 && ` ${c.dropped} page${c.dropped === 1 ? "" : "s"} no longer scored`}
              {c.likeForLikeDelta !== null && (
                <>
                  {` — across the ${c.compared} page${c.compared === 1 ? "" : "s"} in both runs the average moved `}
                  <Delta value={c.likeForLikeDelta} />.
                </>
              )}
            </p>
          )}

          {nothingMoved && c.compared > 0 && !pageSetChanged && (
            <p className="text-xs mt-1.5" style={{ color: "var(--text-3)" }}>
              No page score moved. Scoring is deterministic, so identical content
              re-scores identically — re-publish your optimized pages, then re-run.
            </p>
          )}

          {/* The AIO/PAA numbers are on a monthly cache. If this run copied
              them, "unchanged" would be a statement about the cache, not
              about the site. */}
          {serpReused && (
            <p className="text-xs mt-1.5" style={{ color: "#b45309" }}>
              AI Overview &amp; PAA figures were not re-fetched this run — they&apos;re reused
              from the{" "}
              {serpFetchedAt
                ? new Date(serpFetchedAt).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })
                : "earlier"}{" "}
              pull (SERP data refreshes monthly to control API spend). Use{" "}
              <span className="font-semibold">Force live refresh</span> on the Visibility page
              to pull live data now.
            </p>
          )}
        </div>

        {c.topMovers.length > 0 && (
          <div className="min-w-[210px]">
            <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: "var(--text-3)" }}>
              Biggest moves
            </p>
            <div className="mt-1 space-y-0.5">
              {c.topMovers.map((m) => (
                <p key={m.url} className="text-xs flex items-baseline gap-2" style={{ color: "var(--text-2)" }}>
                  <span className="truncate max-w-[180px]" title={m.url}>
                    {pathOf(m.url)}
                  </span>
                  <span className="tabular-nums whitespace-nowrap" style={{ color: "var(--text-3)" }}>
                    {m.prev}→{m.curr}
                  </span>
                  <Delta value={m.delta} />
                </p>
              ))}
            </div>
            <Link
              href={`/projects/${projectId}/pages`}
              className="text-xs font-semibold hover:underline inline-block mt-1"
              style={{ color: "#4f46e5" }}
            >
              All pages →
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
