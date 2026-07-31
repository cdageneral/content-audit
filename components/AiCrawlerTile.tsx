"use client";

// Compact AI-crawler-access tile that sits in the project header beside the
// Latest score / Median grade tiles. Click it to open a popover with the
// per-crawler verdict, the robots.txt rule that decided it, and llms.txt.
//
// This replaces the old full-width AI Crawler Access panel for the "all
// allowed" and "partially restricted" states. A FULLY BLOCKED crawler still
// gets the full-width red bar on the hub — that finding is worth the real
// estate, because no content fix moves the needle until access is opened.
//
// 🔑 Dismissal uses DOCUMENT-LEVEL listeners, never a `fixed inset-0` overlay,
// and the popover self-clamps to the viewport. Both are hard-won rules — see
// the header comment in components/InfoTip.tsx for why.

import { useEffect, useLayoutEffect, useRef, useState } from "react";

// "unknown" = robots.txt could not be READ (403/401/429/5xx/network). It is
// NOT "allowed" — see lib/crawler/ai-access.ts.
export type AiBotStatus = "allowed" | "blocked" | "partial" | "unknown";

export interface AiCrawlerTileData {
  checkedAt: string;
  origin: string;
  robotsFound: boolean;
  /** Optional: rows written before 2026-07-31 lack it — undefined ⇒ reachable. */
  robotsReachable?: boolean;
  robotsStatus?: number | null;
  llmsTxtFound: boolean;
  bots: { name: string; status: AiBotStatus; sampleRule: string | null }[];
}

const useIsoLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

const VIEWPORT_MARGIN = 8;

const TONE = {
  ok: { fg: "#047857", bg: "rgba(16,185,129,0.10)", border: "rgba(16,185,129,0.30)" },
  warn: { fg: "#b45309", bg: "rgba(245,158,11,0.12)", border: "rgba(245,158,11,0.35)" },
  bad: { fg: "#dc2626", bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.35)" },
  mute: { fg: "var(--text-3)", bg: "var(--bg-2)", border: "var(--border)" },
} as const;

function toneFor(status: AiBotStatus) {
  return status === "blocked"
    ? TONE.bad
    : status === "partial"
    ? TONE.warn
    : status === "unknown"
    ? TONE.mute
    : TONE.ok;
}

/** Shield outline with a check / half-fill / cross, colored by overall status. */
function ShieldIcon({ status, size = 22 }: { status: AiBotStatus; size?: number }) {
  const mark =
    status === "blocked" ? (
      <path d="M9 9l6 6M15 9l-6 6" />
    ) : status === "partial" ? (
      <path d="M12 8.6v4.2M12 15.6v.1" />
    ) : status === "unknown" ? (
      <path d="M10.1 9.9a2 2 0 113 1.7c-.7.4-1.1.9-1.1 1.6M12 16.4v.1" />
    ) : (
      <path d="M9 12.2l2.1 2.1L15.2 10" />
    );
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0 }}
    >
      <path d="M12 3l7 3v5.2c0 4.3-2.9 8.2-7 9.3-4.1-1.1-7-5-7-9.3V6l7-3z" />
      {mark}
    </svg>
  );
}

function StatusPill({ status }: { status: AiBotStatus }) {
  const t = toneFor(status);
  return (
    <span
      className="px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap"
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.border}` }}
    >
      {status === "blocked"
        ? "✕ blocked"
        : status === "partial"
        ? "◐ partial"
        : status === "unknown"
        ? "? unverified"
        : "✓ allowed"}
    </span>
  );
}

export default function AiCrawlerTile({ data }: { data: AiCrawlerTileData }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  const total = data.bots.length;
  const blocked = data.bots.filter((b) => b.status === "blocked").length;
  const partial = data.bots.filter((b) => b.status === "partial").length;
  const unknown = data.bots.filter((b) => b.status === "unknown").length;
  // The tile's fraction answers "how many AI crawlers can reach this site at
  // all" — a partially-restricted crawler still gets in, it just can't see
  // every section, so it counts here. The tile COLOR carries that nuance, and
  // the popover spells it out crawler by crawler.
  const reachable = total - blocked;

  // llms.txt is an emerging nice-to-have, NOT an access blocker — it never
  // drives the tile color, only appears as a row inside the popover.
  const overall: AiBotStatus = blocked
    ? "blocked"
    : partial
    ? "partial"
    : unknown
    ? "unknown"
    : "allowed";
  const tone = toneFor(overall);

  // When nothing could be verified, the fraction itself would be a claim we
  // can't support — show an em dash rather than a reassuring "4/4".
  const fraction = unknown === total ? "—" : `${reachable}/${total}`;
  const statusNote = data.robotsStatus ? `HTTP ${data.robotsStatus}` : "no response";

  const summary = blocked
    ? `${blocked} of ${total} AI crawlers are blocked in robots.txt — those engines can't fetch your pages at all.`
    : partial
    ? `${partial} of ${total} AI crawlers are partially restricted — some sections are invisible to those engines.`
    : unknown
    ? `Crawler access is unverified — this site refused our request for robots.txt (${statusNote}).`
    : `All ${total} major AI crawlers can reach your site.`;

  // Clamp the popover into the viewport. Deps are [open] only so it settles in
  // one pass — adding `shift` here would loop.
  useIsoLayoutEffect(() => {
    if (!open) {
      setShift(0);
      return;
    }
    const el = popRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let d = 0;
    if (r.right > vw - VIEWPORT_MARGIN) d = vw - VIEWPORT_MARGIN - r.right;
    if (r.left + d < VIEWPORT_MARGIN) d = VIEWPORT_MARGIN - r.left;
    if (d !== 0) setShift(d);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: Event) {
      const root = rootRef.current;
      if (root && e.target instanceof Node && root.contains(e.target)) return;
      setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const checked = (() => {
    const d = new Date(data.checkedAt);
    return Number.isNaN(d.getTime())
      ? null
      : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  })();

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`AI crawler access — ${summary}`}
        title={summary}
        className="text-center px-5 py-3 rounded-xl transition-colors"
        style={{
          background: "var(--bg-1)",
          border: `1px solid ${overall === "allowed" ? "var(--border)" : tone.border}`,
          cursor: "pointer",
        }}
      >
        <div
          className="text-3xl font-bold flex items-center justify-center gap-1.5"
          style={{ color: tone.fg, lineHeight: 1.1 }}
        >
          <ShieldIcon status={overall} size={26} />
          {fraction}
        </div>
        <div
          className="text-xs mt-0.5 flex items-center justify-center gap-1"
          style={{ color: "var(--text-3)" }}
        >
          AI crawlers
          <svg
            width="9"
            height="9"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ transform: open ? "rotate(180deg)" : undefined, transition: "transform .15s" }}
          >
            <path d="M2.5 4.5L6 8l3.5-3.5" />
          </svg>
        </div>
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute z-50 top-[calc(100%+6px)] left-1/2 w-80 rounded-lg border border-slate-200 bg-white p-3 shadow-lg text-left"
          style={{
            transform: `translateX(calc(-50% + ${shift}px))`,
            maxWidth: `calc(100vw - ${VIEWPORT_MARGIN * 2}px)`,
          }}
        >
          <p className="text-[11px] font-bold text-slate-800 mb-1">AI Crawler Access</p>
          <p className="text-[11px] leading-relaxed mb-2" style={{ color: tone.fg, fontWeight: 600 }}>
            {summary}
          </p>
          <p className="text-[11px] text-slate-600 leading-relaxed mb-2.5">
            Read from your site&apos;s robots.txt at the start of the last audit run: can the crawlers
            behind ChatGPT, Claude, Perplexity, and Google&apos;s AI training reach your pages? A blocked
            crawler can&apos;t fetch your content at answer time — no content fix changes that until
            access is opened.
            {data.robotsReachable === false
              ? ` We could not read ${data.origin}/robots.txt — the site refused the request (${statusNote}). That is not the same as "allowed": the file may well exist and may restrict AI crawlers. Nothing here is verified until the site lets us read it.`
              : !data.robotsFound
              ? " No robots.txt was found, so crawlers are allowed by default."
              : ""}
          </p>

          <div className="space-y-1">
            {data.bots.map((b) => (
              <div key={b.name} className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-[11px] font-semibold text-slate-800">{b.name}</span>
                  {b.sampleRule && (
                    <span className="block text-[10px] font-mono text-slate-500 truncate">
                      robots.txt: {b.sampleRule}
                    </span>
                  )}
                </div>
                <StatusPill status={b.status} />
              </div>
            ))}
            <div className="flex items-start justify-between gap-2 pt-1 mt-1 border-t border-slate-100">
              <div className="min-w-0">
                <span className="text-[11px] font-semibold text-slate-800">llms.txt</span>
                <span className="block text-[10px] text-slate-500">
                  {data.llmsTxtFound
                    ? `${data.origin}/llms.txt exists`
                    : "Emerging standard — a curated map of your site for AI systems"}
                </span>
              </div>
              <span
                className="px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap"
                style={
                  data.llmsTxtFound
                    ? { background: TONE.ok.bg, color: TONE.ok.fg, border: `1px solid ${TONE.ok.border}` }
                    : { background: TONE.mute.bg, color: TONE.mute.fg, border: `1px solid ${TONE.mute.border}` }
                }
              >
                {data.llmsTxtFound ? "✓ present" : "— missing"}
              </span>
            </div>
          </div>

          {checked && (
            <p className="text-[10px] text-slate-400 mt-2.5">
              Checked {checked} · {data.origin}/robots.txt
            </p>
          )}
        </div>
      )}
    </div>
  );
}
