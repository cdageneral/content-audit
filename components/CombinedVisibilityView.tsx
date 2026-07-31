'use client';

// ─────────────────────────────────────────────────────────────
//  CombinedVisibilityView — the "Combined" tab: every keyword
//  placed on Google rank × AI-answer citation. Four quadrants,
//  each with an obvious next move. Deterministic classification
//  from observed data only (lib/rankings/rollup) — the
//  "recommended move" text is rule-based wording, never a
//  predicted outcome.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import type { RankRollup, RankedKeywordRow, RankQuadrant } from '@/lib/rankings/rollup';

const QUADS: {
  key: RankQuadrant;
  label: string;
  color: string;
  desc: string;
}[] = [
  {
    key: 'own',
    label: 'Owning both',
    color: '#059669',
    desc: 'Top-10 rank and cited in the AI answer. Defend these.',
  },
  {
    key: 'canwin',
    label: 'Can win in AI',
    color: '#4f46e5',
    desc: 'Top-10 rank, but the AI answer doesn’t cite you. Highest-leverage fixes.',
  },
  {
    key: 'aifirst',
    label: 'AI-first',
    color: '#a56bfb',
    desc: 'Cited by AI while ranking outside the top 10. Classic-SEO upside on proven content.',
  },
  {
    key: 'invisible',
    label: 'Invisible',
    color: '#9ca3af',
    desc: 'Neither top-10 nor cited. The long-game queue.',
  },
];

function moveText(k: RankedKeywordRow): string {
  switch (k.quad) {
    case 'canwin':
      if (!k.aiPresent)
        return `Ranks #${k.position} with no AI answer on the SERP yet — hold position and watch for an AI Overview arriving.`;
      return k.aioWinners.length > 0
        ? `You rank #${k.position} but the AI answer cites ${k.aioWinners[0]} — add a citable, direct answer block to compete for the citation.`
        : `You rank #${k.position} but aren't cited in the AI answer — add a citable, direct answer block.`;
    case 'aifirst':
      return k.position > 0
        ? `AI already cites this page while it ranks #${k.position} — internal links and title work to push it into the top 10.`
        : 'AI cites this page but no organic rank was captured — classic on-page and internal-link work.';
    case 'own':
      return `Ranked #${k.position} and cited — keep it fresh and re-check on the next scan.`;
    default:
      return k.aiPresent
        ? k.aioWinners.length > 0
          ? `${k.position > 0 ? `#${k.position}` : 'No rank captured'} and the AI answer cites ${k.aioWinners[0]} — needs both content depth and authority work.`
          : `${k.position > 0 ? `Ranks #${k.position}` : 'No rank captured'} and not cited — needs both content depth and authority work.`
        : `${k.position > 0 ? `Ranks #${k.position}` : 'No rank captured'}, no AI answer captured — classic SEO queue, prioritize by intent.`;
  }
}

export default function CombinedVisibilityView({
  projectId,
  rollup,
}: {
  projectId: string;
  rollup: RankRollup;
}) {
  const [sel, setSel] = useState<RankQuadrant | null>(null);

  // Non-branded only — same population as the quadrant counts.
  const all = useMemo(() => rollup.keywords.filter((k) => !k.branded), [rollup.keywords]);
  const rows = useMemo(() => (sel ? all.filter((k) => k.quad === sel) : all), [all, sel]);

  // Plot at most 120 dots so a big keyword set stays readable.
  const dots = useMemo(() => all.slice(0, 120), [all]);

  const W = 720;
  const H = 300;
  const padL = 50;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const midX = padL + plotW * 0.42; // top-10 boundary sits left of center
  const midY = padT + plotH / 2;

  // x: rank #1 at the left edge → #50+ (and "no rank captured") at the right.
  const xOf = (k: RankedKeywordRow) => {
    if (k.position === 0) return padL + plotW * 0.97;
    const p = Math.min(k.position, 50);
    return p <= 10
      ? padL + ((p - 1) / 9) * (plotW * 0.42 - 14) + 6
      : midX + ((p - 10) / 40) * (plotW * 0.58 - 20) + 8;
  };
  // y: cited keywords in the top band, uncited below; deterministic jitter
  // (index-based — Math.random would break SSR hydration).
  const yOf = (k: RankedKeywordRow, i: number) => {
    const jitter = ((i * 37) % 80) / 80;
    return k.cited ? padT + 12 + jitter * (plotH / 2 - 24) : midY + 12 + jitter * (plotH / 2 - 24);
  };
  const colorOf = (q: RankQuadrant) => QUADS.find((x) => x.key === q)!.color;

  return (
    <div className="space-y-5">
      {/* ── Quadrant tiles ────────────────────────────────── */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {QUADS.map((q) => (
          <button
            key={q.key}
            type="button"
            onClick={() => setSel(sel === q.key ? null : q.key)}
            className="card card-interactive p-4 text-left transition-colors"
            style={sel === q.key ? { borderColor: q.color, boxShadow: `0 0 0 1px ${q.color}` } : undefined}
          >
            <p className="text-[13px] font-extrabold flex items-center gap-2" style={{ color: 'var(--text-1)' }}>
              <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: q.color }} />
              {q.label}
            </p>
            <p className="text-[22px] font-extrabold mt-0.5" style={{ color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
              {rollup.quadCounts[q.key]}{' '}
              <span className="text-[11.5px] font-semibold" style={{ color: 'var(--text-3)' }}>keywords</span>
            </p>
            <p className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-3)' }}>
              {q.desc}
              {q.key === 'canwin' && rollup.canwinNoAi > 0
                ? ` (${rollup.canwinNoAi} have no AI answer on the SERP yet)`
                : ''}
            </p>
          </button>
        ))}
      </div>

      {/* ── Quadrant map ──────────────────────────────────── */}
      <div className="card p-5">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
            Dual visibility map
          </p>
          <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
            click a tile or a dot to filter the list
            {all.length > 120 ? ` · plotting 120 of ${all.length}` : ''}
          </p>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto mt-2" aria-label="Google rank versus AI citation quadrant map">
          <rect x={padL} y={padT} width={midX - padL} height={plotH / 2} fill="rgba(5,150,105,0.06)" rx="8" />
          <rect x={midX} y={padT} width={W - padR - midX} height={plotH / 2} fill="rgba(165,107,251,0.08)" rx="8" />
          <rect x={padL} y={midY} width={midX - padL} height={plotH / 2} fill="rgba(79,70,229,0.06)" rx="8" />
          <rect x={midX} y={midY} width={W - padR - midX} height={plotH / 2} fill="rgba(148,163,184,0.09)" rx="8" />
          <line x1={midX} y1={padT} x2={midX} y2={H - padB} stroke="var(--border)" strokeDasharray="4 4" />
          <line x1={padL} y1={midY} x2={W - padR} y2={midY} stroke="var(--border)" strokeDasharray="4 4" />
          <text x={padL + 10} y={padT + 16} fontSize="10.5" fontWeight="700" fill="#059669">
            OWNING BOTH · {rollup.quadCounts.own}
          </text>
          <text x={W - padR - 10} y={padT + 16} textAnchor="end" fontSize="10.5" fontWeight="700" fill="#a56bfb">
            AI-FIRST · {rollup.quadCounts.aifirst}
          </text>
          <text x={padL + 10} y={H - padB - 8} fontSize="10.5" fontWeight="700" fill="#4f46e5">
            CAN WIN IN AI · {rollup.quadCounts.canwin}
          </text>
          <text x={W - padR - 10} y={H - padB - 8} textAnchor="end" fontSize="10.5" fontWeight="700" fill="#9ca3af">
            INVISIBLE · {rollup.quadCounts.invisible}
          </text>
          <text x={padL} y={H - 8} fontSize="10" fill="#6b7280">← rank #1</text>
          <text x={midX} y={H - 8} textAnchor="middle" fontSize="10" fill="#6b7280">top-10 boundary</text>
          <text x={W - padR} y={H - 8} textAnchor="end" fontSize="10" fill="#6b7280">#50+ / no rank →</text>
          <text x={padL - 38} y={padT + plotH / 4} fontSize="10" fill="#6b7280" transform={`rotate(-90 ${padL - 38} ${padT + plotH / 4})`} textAnchor="middle">
            cited by AI
          </text>
          <text x={padL - 38} y={midY + plotH / 4} fontSize="10" fill="#6b7280" transform={`rotate(-90 ${padL - 38} ${midY + plotH / 4})`} textAnchor="middle">
            not cited
          </text>
          {dots.map((k, i) => (
            <circle
              key={k.keyword}
              cx={xOf(k)}
              cy={yOf(k, i)}
              r={sel === k.quad ? 6.5 : 5}
              fill={colorOf(k.quad)}
              opacity={sel && sel !== k.quad ? 0.25 : 0.85}
              className="cursor-pointer"
              onClick={() => setSel(sel === k.quad ? null : k.quad)}
            >
              <title>
                {`${k.keyword} — ${k.position > 0 ? `#${k.position}` : 'no rank captured'}, ${
                  k.cited ? 'cited by AI' : k.aiPresent ? 'AI answer cites others' : 'no AI answer captured'
                }`}
              </title>
            </circle>
          ))}
        </svg>
      </div>

      {/* ── Next moves ────────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="px-5 pt-4 pb-3 flex items-baseline justify-between gap-3 flex-wrap" style={{ borderBottom: '1px solid var(--border)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
            Next moves — {sel ? QUADS.find((q) => q.key === sel)?.label : 'all quadrants'}
          </p>
          {sel && (
            <button type="button" onClick={() => setSel(null)} className="text-[12px] font-bold" style={{ color: '#4f46e5' }}>
              ✕ show all
            </button>
          )}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-4 py-2.5" style={{ color: 'var(--text-3)' }}>Keyword</th>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>Rank</th>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>Recommended move</th>
                <th className="px-4 py-2.5"></th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 40).map((k) => (
                <tr key={k.keyword} style={{ borderTop: '1px solid var(--border)' }}>
                  <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--text-1)' }}>
                    <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ background: colorOf(k.quad) }} />
                    {k.keyword}
                  </td>
                  <td className="px-3 py-2.5 whitespace-nowrap tabular-nums font-bold" style={{ color: 'var(--text-2)' }}>
                    {k.position > 0 ? `#${k.position}` : '—'}
                  </td>
                  <td className="px-3 py-2.5 max-w-[420px]" style={{ color: 'var(--text-2)' }}>
                    {moveText(k)}
                  </td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {k.pageId ? (
                      <a
                        href={`/projects/${projectId}/optimize/${k.pageId}`}
                        className="text-xs font-semibold hover:underline"
                        style={{ color: '#4f46e5' }}
                      >
                        Open in Optimize →
                      </a>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--text-3)' }}>—</span>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center" style={{ color: 'var(--text-3)' }}>
                    No keywords in this quadrant yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {rows.length > 40 && (
          <p className="px-5 py-2.5 text-[11px]" style={{ color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>
            Showing the first 40 of {rows.length} — filter by quadrant to narrow the list.
          </p>
        )}
        <p className="px-5 py-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>
          Classification is rule-based from observed scan data: top-10 = best organic position 1–10;
          cited = a page of yours is cited in the AI Overview or owns the PAA answer. Recommended moves
          are standing playbook wording — never a predicted ranking or citation outcome.
        </p>
      </div>
    </div>
  );
}
