'use client';

// ─────────────────────────────────────────────────────────────
//  RankingsView — the Google Rankings tab (Visibility section).
//  Renders the rank rollup computed server-side from stored SERP
//  snapshots. Every figure here is an OBSERVED position from a
//  real scan — no estimates, no modeled traffic, no interpolation.
//  "—" means no organic rank was captured, never zero-as-data.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import type { RankRollup, RankedKeywordRow } from '@/lib/rankings/rollup';
import {
  AIO_CTR_SOURCE,
  AIO_CTR_SOURCE_URL,
  AIO_FACTOR_CITED,
  AIO_FACTOR_UNCITED,
  CTR_SOURCE,
  CTR_SOURCE_URL,
} from '@/lib/rankings/ctr';

type SegKey = 'top3' | 'p410' | 'p1120' | 'p2150' | 'p51' | 'unranked';
type ChipKey = 'all' | 'up' | 'dn' | 'new' | 'strike' | 'aio' | 'cited';
type SortKey = 'position' | 'volume' | 'traffic' | 'moves';
/** What the distribution bar measures: keyword count, or the demand behind them. */
type DistMode = 'count' | 'demand';

/** Compact form for tile figures — 412,300 reads as 412.3k at 25px. */
function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

/** Share of a total as a whole percent, or null when the total is zero. */
function pctOf(part: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((part / total) * 100);
}

const SEGMENTS: { key: SegKey; label: string; color: string }[] = [
  { key: 'top3', label: 'Top 3', color: '#059669' },
  { key: 'p410', label: '4–10', color: '#4f46e5' },
  { key: 'p1120', label: '11–20', color: '#a56bfb' },
  { key: 'p2150', label: '21–50', color: '#d97706' },
  { key: 'p51', label: '51+', color: '#9ca3af' },
  { key: 'unranked', label: 'No rank captured', color: '#64748b' },
];

function segOf(k: RankedKeywordRow): SegKey {
  if (k.position === 0) return 'unranked';
  if (k.position <= 3) return 'top3';
  if (k.position <= 10) return 'p410';
  if (k.position <= 20) return 'p1120';
  if (k.position <= 50) return 'p2150';
  return 'p51';
}

function posTone(pos: number): { bg: string; fg: string } {
  if (pos === 0) return { bg: 'var(--bg-3)', fg: 'var(--text-3)' };
  if (pos <= 3) return { bg: 'rgba(5,150,105,0.12)', fg: '#059669' };
  if (pos <= 10) return { bg: 'rgba(79,70,229,0.1)', fg: '#4f46e5' };
  if (pos <= 20) return { bg: 'rgba(217,119,6,0.12)', fg: '#d97706' };
  return { bg: 'var(--bg-3)', fg: 'var(--text-3)' };
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

export default function RankingsView({
  projectId,
  rollup,
}: {
  projectId: string;
  rollup: RankRollup;
}) {
  const [seg, setSeg] = useState<SegKey | null>(null);
  const [chip, setChip] = useState<ChipKey>('all');
  const [includeBranded, setIncludeBranded] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('position');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [distMode, setDistMode] = useState<DistMode>('count');
  const [aioAdj, setAioAdj] = useState(false);
  const [volBusy, setVolBusy] = useState(false);
  const [volMsg, setVolMsg] = useState<string | null>(null);

  async function fetchVolumes() {
    setVolBusy(true);
    setVolMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/volumes`, { method: 'POST' });
      const j = (await res.json()) as { message?: string; error?: string; rowsUpdated?: number };
      if (!res.ok) {
        setVolMsg(j.error ?? 'Could not fetch search volumes.');
      } else {
        setVolMsg(`${j.message ?? 'Done.'} Reload to see them.`);
      }
    } catch {
      setVolMsg('Could not reach the server — please try again.');
    } finally {
      setVolBusy(false);
    }
  }

  const d = rollup.demand;
  // Volume coverage is shown wherever a demand total is shown. A figure
  // covering 812 of 859 keywords is useful; the same figure presented as if
  // it covered all 859 is not.
  const partialVolume = rollup.volumesOk && d.covered < d.tracked;

  const avgDelta =
    rollup.avgPosition !== null && rollup.prevAvgPosition !== null
      ? Math.round((rollup.prevAvgPosition - rollup.avgPosition) * 10) / 10
      : null;
  const top10Delta = rollup.prevTop10 !== null ? rollup.top10 - rollup.prevTop10 : null;

  const rows = useMemo(() => {
    let r = rollup.keywords.filter((k) => includeBranded || !k.branded);
    if (seg) r = r.filter((k) => segOf(k) === seg);
    if (chip === 'up') r = r.filter((k) => (k.delta ?? 0) > 0);
    else if (chip === 'dn') r = r.filter((k) => (k.delta ?? 0) < 0);
    else if (chip === 'new') r = r.filter((k) => k.isNew);
    else if (chip === 'strike') r = r.filter((k) => k.position >= 11 && k.position <= 20);
    else if (chip === 'aio') r = r.filter((k) => k.aioTriggered);
    else if (chip === 'cited') r = r.filter((k) => k.cited);
    const sorted = [...r];
    if (sortKey === 'volume') {
      sorted.sort((a, b) => (b.volume ?? -1) - (a.volume ?? -1) || a.keyword.localeCompare(b.keyword));
    } else if (sortKey === 'traffic') {
      const est = (k: RankedKeywordRow) => (aioAdj ? k.estTrafficAio : k.estTraffic) ?? -1;
      sorted.sort((a, b) => est(b) - est(a) || a.keyword.localeCompare(b.keyword));
    } else if (sortKey === 'moves') {
      sorted.sort(
        (a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0) || a.keyword.localeCompare(b.keyword)
      );
    } // 'position' keeps the server's deterministic order
    return sorted;
  }, [rollup.keywords, seg, chip, includeBranded, sortKey, aioAdj]);

  const chips: { key: ChipKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'up', label: '▲ Improved' },
    { key: 'dn', label: '▼ Declined' },
    { key: 'new', label: 'New this scan' },
    { key: 'strike', label: 'Striking distance (11–20)' },
    { key: 'aio', label: 'AI Overview on SERP' },
    { key: 'cited', label: 'Cited by AI' },
  ];

  const dist = rollup.distribution;
  const distTotal = SEGMENTS.reduce((s, x) => s + dist[x.key], 0);
  // The bar shows either how MANY keywords sit in a band or how much monthly
  // demand does — the second is the one that says where the money is.
  const measure = (k: SegKey): number => (distMode === 'demand' ? d.byBucket[k] : dist[k]);

  return (
    <div className="space-y-5">
      {/* ── KPI tiles ─────────────────────────────────────── */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
            Tracked keywords
          </p>
          <p className="text-[25px] font-extrabold mt-1" style={{ color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
            {rollup.tracked}
          </p>
          <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
            {rollup.volumesOk ? (
              <>
                <span className="font-bold" style={{ color: 'var(--text-2)' }}>
                  {compact(d.total)} searches/mo
                </span>{' '}
                of tracked demand
                {partialVolume ? ` · volume on ${d.covered} of ${d.tracked}` : ''}
              </>
            ) : (
              'keywords your pages rank for, from the latest scan'
            )}
            {rollup.brandedCount > 0 ? ` · +${rollup.brandedCount} branded (excluded)` : ''}
          </p>
        </div>
        <div className="card p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
            Average position
          </p>
          <p className="text-[25px] font-extrabold mt-1" style={{ color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
            {rollup.avgPosition ?? '—'}
          </p>
          <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
            {avgDelta !== null ? (
              <span
                className="font-bold"
                style={{ color: avgDelta > 0 ? '#059669' : avgDelta < 0 ? '#dc2626' : 'var(--text-3)' }}
              >
                {avgDelta > 0 ? `▲ ${avgDelta} better` : avgDelta < 0 ? `▼ ${Math.abs(avgDelta)} worse` : '— unchanged'}
              </span>
            ) : (
              'first scan with rank data'
            )}
            {avgDelta !== null ? ' vs prior scan' : ''} · across {rollup.ranked} ranked
          </p>
          {d.weightedAvgPosition !== null && (
            <p
              className="text-[11.5px] mt-1 pt-1"
              style={{ color: 'var(--text-3)', borderTop: '1px dashed var(--border)' }}
              title="Each keyword's position weighted by its monthly search volume — a #3 on 40,000 searches counts far more than a #3 on 20."
            >
              <span className="font-bold" style={{ color: '#4f46e5' }}>
                #{d.weightedAvgPosition}
              </span>{' '}
              weighted by demand
            </p>
          )}
        </div>
        <div className="card p-4">
          <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
            Top-10 rankings
          </p>
          <p className="text-[25px] font-extrabold mt-1" style={{ color: 'var(--text-1)', letterSpacing: '-0.01em' }}>
            {rollup.top10} <span className="text-[13px] font-semibold" style={{ color: 'var(--text-3)' }}>of {rollup.tracked}</span>
          </p>
          <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
            {top10Delta !== null ? (
              <span
                className="font-bold"
                style={{ color: top10Delta > 0 ? '#059669' : top10Delta < 0 ? '#dc2626' : 'var(--text-3)' }}
              >
                {top10Delta > 0 ? `▲ ${top10Delta}` : top10Delta < 0 ? `▼ ${Math.abs(top10Delta)}` : '—'}
              </span>
            ) : null}
            {top10Delta !== null ? ' vs prior scan · ' : ''}
            {rollup.top3} in the top 3
          </p>
          {rollup.volumesOk && pctOf(d.top10, d.total) !== null && (
            <p
              className="text-[11.5px] mt-1 pt-1"
              style={{ color: 'var(--text-3)', borderTop: '1px dashed var(--border)' }}
              title="Share of the tracked monthly search volume that sits on keywords you already rank 1–10 for."
            >
              <span className="font-bold" style={{ color: '#059669' }}>
                {pctOf(d.top10, d.total)}%
              </span>{' '}
              of demand captured on page 1
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => {
            setSeg(seg === 'p1120' ? null : 'p1120');
            setChip('all');
          }}
          className="card card-interactive p-4 text-left"
          title="Positions 11–20 — one push from page 1. Click to filter."
        >
          <p className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-3)' }}>
            Striking distance
          </p>
          <p className="text-[25px] font-extrabold mt-1" style={{ color: '#a56bfb', letterSpacing: '-0.01em' }}>
            {rollup.striking}
          </p>
          <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
            {rollup.volumesOk && d.striking > 0 ? (
              <>
                <span className="font-bold" style={{ color: '#a56bfb' }}>
                  {compact(d.striking)} searches/mo
                </span>{' '}
                at 11–20 — one push from page 1 →
              </>
            ) : (
              'keywords at 11–20 — one push from page 1 →'
            )}
          </p>
        </button>
      </div>

      {/* ── No verified volume yet ────────────────────────── */}
      {!rollup.volumesOk && (
        <div className="card p-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div className="max-w-[62ch]">
              <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
                Search volume isn&apos;t showing for this scan
              </p>
              <p className="text-[12.5px] mt-1" style={{ color: 'var(--text-3)' }}>
                The scan stored Google Ads volumes, which report one shared total for a keyword and
                every close variant of it — so a single number can be off by orders of magnitude and
                a total of them is meaningless. Fetching per-keyword volumes replaces them with real
                figures and unlocks demand-weighted position, demand captured on page 1, and the
                striking-distance opportunity. It reads the keywords already stored — no re-crawl.
              </p>
            </div>
            <button
              type="button"
              onClick={fetchVolumes}
              disabled={volBusy}
              className="rounded-lg px-3.5 py-2 text-[12.5px] font-bold text-white whitespace-nowrap disabled:opacity-60"
              style={{ background: '#4f46e5' }}
            >
              {volBusy ? 'Fetching…' : 'Fetch search volumes'}
            </button>
          </div>
          {volMsg && (
            <p className="text-[12px] mt-2.5 font-medium" style={{ color: 'var(--text-2)' }}>
              {volMsg}
            </p>
          )}
        </div>
      )}

      {/* ── Distribution ──────────────────────────────────── */}
      {distTotal > 0 && (
        <div className="card p-5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
              Where you rank
            </p>
            <div className="flex items-center gap-3 flex-wrap">
              {rollup.volumesOk && (
                <div
                  className="inline-flex rounded-lg overflow-hidden border"
                  style={{ borderColor: 'var(--border)' }}
                  role="group"
                  aria-label="Measure the distribution by keyword count or by search demand"
                >
                  {(
                    [
                      ['count', 'Keywords'],
                      ['demand', 'Demand'],
                    ] as [DistMode, string][]
                  ).map(([m, label]) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setDistMode(m)}
                      className="px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
                      style={
                        distMode === m
                          ? { background: '#4f46e5', color: '#fff' }
                          : { background: 'var(--bg-1)', color: 'var(--text-2)' }
                      }
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
                click a segment to filter · non-branded keywords
              </p>
            </div>
          </div>
          <div className="flex h-8 rounded-lg overflow-hidden mt-3" role="group" aria-label="Position distribution">
            {SEGMENTS.filter((s) => measure(s.key) > 0).map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => {
                  setSeg(seg === s.key ? null : s.key);
                  setChip('all');
                }}
                className="flex items-center justify-center text-white text-[11.5px] font-bold min-w-[30px] transition-opacity hover:opacity-90"
                style={{
                  flex: measure(s.key),
                  background: s.color,
                  outline: seg === s.key ? '2.5px solid var(--text-1)' : 'none',
                  outlineOffset: '-2.5px',
                }}
                title={
                  distMode === 'demand'
                    ? `${s.label} — ${d.byBucket[s.key].toLocaleString()} searches/mo`
                    : `${s.label} — ${dist[s.key]} keyword${dist[s.key] === 1 ? '' : 's'}`
                }
              >
                {distMode === 'demand' ? compact(d.byBucket[s.key]) : dist[s.key]}
              </button>
            ))}
          </div>
          <div className="flex gap-4 flex-wrap mt-2.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
            {SEGMENTS.map((s) => (
              <span key={s.key} className="inline-flex items-center gap-1.5 font-medium">
                <i className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
          {distMode === 'demand' && (
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-3)' }}>
              Each band is sized by monthly search volume instead of keyword count
              {partialVolume
                ? `, across the ${d.covered} of ${d.tracked} keywords with a verified volume`
                : ''}
              . Bands can look very different here — a handful of high-demand keywords outweighs a
              long tail of rarely-searched ones.
            </p>
          )}
          {dist.unranked > 0 && (
            <p className="text-[11px] mt-2" style={{ color: 'var(--text-3)' }}>
              “No rank captured” = the keyword appeared in this page&apos;s SERP data without an organic
              position (e.g. cited in an AI Overview only) — it is not a verified “ranks nowhere”.
            </p>
          )}
        </div>
      )}

      {/* ── Trend (one point per scan — never interpolated) ── */}
      {rollup.trend.length > 1 ? (
        <div className="card p-5">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
              Ranking trend
            </p>
            <p className="text-[11.5px]" style={{ color: 'var(--text-3)' }}>
              one point per scan · {rollup.trend.length} scans
            </p>
          </div>
          <div className="flex gap-4 flex-wrap mt-2 text-[12px] font-semibold" style={{ color: 'var(--text-2)' }}>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: '#4f46e5' }} />
              Average position (lower is better)
            </span>
            <span className="inline-flex items-center gap-1.5">
              <i className="inline-block w-2.5 h-2.5 rounded-[3px]" style={{ background: '#059669' }} />
              Keywords in top 10
            </span>
          </div>
          <TrendSvg trend={rollup.trend} />
        </div>
      ) : (
        <div className="card p-4">
          <p className="text-[12.5px]" style={{ color: 'var(--text-3)' }}>
            The trend chart appears after your second scan with SERP data — one honest point per scan,
            nothing interpolated.
          </p>
        </div>
      )}

      {/* ── Keyword table ─────────────────────────────────── */}
      <div className="card overflow-hidden">
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
              Keywords
            </p>
            <div className="flex items-center gap-3 text-[12px]" style={{ color: 'var(--text-3)' }}>
              <label className="inline-flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="accent-indigo-600"
                  checked={includeBranded}
                  onChange={(e) => setIncludeBranded(e.target.checked)}
                />
                include branded ({rollup.brandedCount})
              </label>
              <label className="inline-flex items-center gap-1.5">
                sort
                <select
                  className="rounded border px-1.5 py-0.5 text-[12px] bg-transparent"
                  style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}
                  value={sortKey}
                  onChange={(e) => setSortKey(e.target.value as SortKey)}
                >
                  <option value="position">Position</option>
                  <option value="moves">Biggest moves</option>
                  {rollup.volumesOk && <option value="volume">Volume</option>}
                  {rollup.volumesOk && <option value="traffic">Est. traffic</option>}
                </select>
              </label>
              {rollup.volumesOk && rollup.demand.estTrafficOnAio > 0 && (
                <label
                  className="inline-flex items-center gap-1.5 cursor-pointer select-none"
                  title={`Multiplies the estimate on keywords whose SERP carries an AI answer — \u00d7${AIO_FACTOR_UNCITED} when you are not cited, \u00d7${AIO_FACTOR_CITED} when you are. Both ratios come from measured CTR (${AIO_CTR_SOURCE}).`}
                >
                  <input
                    type="checkbox"
                    className="accent-indigo-600"
                    checked={aioAdj}
                    onChange={(e) => setAioAdj(e.target.checked)}
                  />
                  AI Overview discount
                </label>
              )}
            </div>
          </div>
          <div className="flex gap-2 flex-wrap mt-2.5">
            {chips.map((c) => (
              <button
                key={c.key}
                type="button"
                onClick={() => setChip(c.key)}
                className="rounded-full px-3 py-1 text-[12px] font-semibold border transition-colors"
                style={
                  chip === c.key
                    ? { background: '#4f46e5', borderColor: '#4f46e5', color: '#fff' }
                    : { borderColor: 'var(--border)', color: 'var(--text-2)', background: 'var(--bg-1)' }
                }
              >
                {c.label}
              </button>
            ))}
            {(seg || chip !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSeg(null);
                  setChip('all');
                }}
                className="text-[12px] font-bold px-2"
                style={{ color: '#4f46e5' }}
              >
                ✕ clear
              </button>
            )}
          </div>
          {rollup.volumesOk && d.estTrafficTotal > 0 && (
            <p className="text-[11.5px] mt-2" style={{ color: 'var(--text-2)' }}>
              <span className="font-bold" style={{ color: '#a56bfb' }}>
                ~{d.estTrafficTotal.toLocaleString()} modelled clicks/mo
              </span>{' '}
              across page-1 keywords
              {d.estTrafficAdjTotal !== d.estTrafficTotal && (
                <> · ~{d.estTrafficAdjTotal.toLocaleString()} with the AI Overview discount applied</>
              )}
            </p>
          )}
          <p className="text-[11.5px] mt-2" style={{ color: 'var(--text-3)' }}>
            {rows.length} keyword{rows.length === 1 ? '' : 's'}
            {seg ? ` · ${SEGMENTS.find((s) => s.key === seg)?.label}` : ''} · click a row for detail
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr style={{ background: 'var(--bg-2)' }}>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-4 py-2.5" style={{ color: 'var(--text-3)' }}>Keyword</th>
                <th className="text-right font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>Vol/mo</th>
                {rollup.volumesOk && (
                  <th
                    className="text-right font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5 whitespace-nowrap"
                    style={{ color: 'var(--text-3)' }}
                    title="Modelled: monthly search volume × the published average click-through rate for this position. Not measured traffic."
                  >
                    Est. traffic
                    <span className="ml-1 font-semibold normal-case tracking-normal" style={{ color: '#a56bfb' }}>
                      {aioAdj ? 'modelled · AIO-adj' : 'modelled'}
                    </span>
                  </th>
                )}
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>Position</th>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>Best page</th>
                <th className="text-left font-bold uppercase tracking-wider text-[10.5px] px-3 py-2.5" style={{ color: 'var(--text-3)' }}>AI answer</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => {
                const tone = posTone(k.position);
                const isOpen = expanded === k.keyword;
                return (
                  <FragmentRow
                    key={k.keyword}
                    k={k}
                    tone={tone}
                    isOpen={isOpen}
                    projectId={projectId}
                    showTraffic={rollup.volumesOk}
                    aioAdj={aioAdj}
                    onToggle={() => setExpanded(isOpen ? null : k.keyword)}
                  />
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={rollup.volumesOk ? 6 : 5} className="px-4 py-6 text-center text-[12.5px]" style={{ color: 'var(--text-3)' }}>
                    No keywords match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="px-5 py-3 text-[11px] leading-relaxed" style={{ color: 'var(--text-3)', borderTop: '1px solid var(--border)' }}>
          <span className="font-semibold" style={{ color: 'var(--text-2)' }}>Source:</span> organic positions
          from the DataForSEO SERP snapshots stored with each scan — the same data behind the AI Answers tab.
          Positions refresh on the project&apos;s scan cadence.
          {rollup.volumesOk ? (
            <>
              {' '}
              Search volume is the per-keyword monthly figure from DataForSEO&apos;s Search Volume
              endpoint
              {partialVolume
                ? `, available for ${d.covered} of ${d.tracked} keywords — the rest show “—” and are left out of every total`
                : ''}
              . Google Ads volumes are deliberately not used: they report one shared total for a
              keyword and all its close variants.
              <br />
              <span className="font-semibold" style={{ color: '#a56bfb' }}>
                Est. traffic is modelled, not measured.
              </span>{' '}
              It multiplies verified volume by a published average click-through rate for the
              position (
              <a
                href={CTR_SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
                style={{ color: 'var(--text-2)' }}
              >
                {CTR_SOURCE}
              </a>
              ; sample size not disclosed by the publisher). Published curves cover page 1 only, so
              positions 11+ show “—”. Real CTR swings widely with intent and brand.
              {d.estTrafficOnAio > 0 && pctOf(d.estTrafficOnAio, d.estTrafficTotal) !== null && (
                <>
                  {' '}
                  Treat {pctOf(d.estTrafficOnAio, d.estTrafficTotal)}% of this estimate as likely
                  high: it sits on SERPs carrying an AI Overview, where measured organic CTR ran
                  0.61% uncited / 0.70% cited against 1.62% with no AI Overview (
                  <a
                    href={AIO_CTR_SOURCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline"
                    style={{ color: 'var(--text-2)' }}
                  >
                    {AIO_CTR_SOURCE}
                  </a>
                  ).
                </>
              )}
            </>
          ) : (
            ' Volume and estimated traffic show “—” because no per-keyword volume has been fetched for this scan yet — the next scan fills them in. Google Ads volumes are never shown: they report one shared total for a keyword and all its close variants.'
          )}
        </p>
      </div>
    </div>
  );
}

// One keyword row + its optional expanded detail row.
function FragmentRow({
  k,
  tone,
  isOpen,
  projectId,
  showTraffic,
  aioAdj,
  onToggle,
}: {
  k: RankedKeywordRow;
  tone: { bg: string; fg: string };
  isOpen: boolean;
  projectId: string;
  showTraffic: boolean;
  aioAdj: boolean;
  onToggle: () => void;
}) {
  const est = aioAdj ? k.estTrafficAio : k.estTraffic;
  return (
    <>
      <tr
        onClick={onToggle}
        className="cursor-pointer transition-colors hover:bg-slate-50"
        style={{ borderTop: '1px solid var(--border)' }}
      >
        <td className="px-4 py-2.5 font-medium" style={{ color: 'var(--text-1)' }}>
          {k.keyword}
          {k.branded && (
            <span className="ml-2 rounded-full px-1.5 py-px text-[9.5px] font-bold align-middle" style={{ background: 'var(--bg-3)', color: 'var(--text-3)' }}>
              brand
            </span>
          )}
          {k.isNew && (
            <span className="ml-2 rounded-full px-1.5 py-px text-[9.5px] font-bold align-middle" style={{ background: 'rgba(111,28,254,0.1)', color: '#6f1cfe' }}>
              new
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums" style={{ color: 'var(--text-2)' }}>
          {k.volume !== null && k.volume > 0 ? k.volume.toLocaleString() : '—'}
        </td>
        {showTraffic && (
          <td
            className="px-3 py-2.5 text-right tabular-nums"
            style={{ color: est !== null ? '#a56bfb' : 'var(--text-3)' }}
            title={
              est !== null
                ? aioAdj && k.aiPresent
                  ? 'Modelled from published average CTR, then discounted because this SERP carries an AI answer.'
                  : 'Modelled from published average CTR for this position — not measured traffic.'
                : k.volume === null
                  ? 'No verified search volume for this keyword.'
                  : 'No published CTR beyond page 1.'
            }
          >
            {est !== null ? `~${est.toLocaleString()}` : '—'}
          </td>
        )}
        <td className="px-3 py-2.5 whitespace-nowrap">
          <span className="inline-flex items-center justify-center rounded-md px-2 py-0.5 min-w-[36px] font-extrabold text-[12.5px]" style={{ background: tone.bg, color: tone.fg }}>
            {k.position > 0 ? `#${k.position}` : '—'}
          </span>
          {k.delta !== null && k.delta !== 0 && (
            <span className="ml-1.5 text-[11.5px] font-bold" style={{ color: k.delta > 0 ? '#059669' : '#dc2626' }}>
              {k.delta > 0 ? `▲${k.delta}` : `▼${Math.abs(k.delta)}`}
            </span>
          )}
          {k.delta === 0 && (
            <span className="ml-1.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>—</span>
          )}
        </td>
        <td className="px-3 py-2.5 max-w-[240px] truncate font-mono text-[11.5px]" style={{ color: 'var(--text-2)' }} title={k.pageUrl}>
          {pathOf2(k.pageUrl)}
        </td>
        <td className="px-3 py-2.5 whitespace-nowrap">
          <AiPill k={k} />
        </td>
      </tr>
      {isOpen && (
        <tr style={{ background: 'var(--bg-2)' }}>
          <td colSpan={showTraffic ? 6 : 5} className="px-5 py-3.5">
            <div className="flex items-start gap-8 flex-wrap text-[12px]" style={{ color: 'var(--text-2)' }}>
              <div>
                <p className="text-[10.5px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-3)' }}>vs prior scan</p>
                <p>
                  {k.prevPosition !== null ? `#${k.prevPosition} → ` : k.isNew ? 'not tracked → ' : 'no prior rank → '}
                  {k.position > 0 ? `#${k.position}` : 'no rank captured'}
                </p>
              </div>
              <div className="max-w-[380px]">
                <p className="text-[10.5px] font-bold uppercase tracking-wider mb-1" style={{ color: 'var(--text-3)' }}>AI answer on this SERP</p>
                <p>
                  {k.cited
                    ? 'Cites your site ✓'
                    : k.aioTriggered
                      ? k.aioWinners.length > 0
                        ? `AI Overview cites ${k.aioWinners.join(', ')} — not you.`
                        : 'AI Overview present — your site is not cited.'
                      : k.paaPresent
                        ? 'People-Also-Ask box present — you don’t own the answer.'
                        : 'No AI Overview or PAA captured on this SERP.'}
                </p>
              </div>
              {k.pageId && (
                <a
                  href={`/projects/${projectId}/optimize/${k.pageId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="inline-block rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 transition-colors"
                >
                  Open page in Optimize →
                </a>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function AiPill({ k }: { k: RankedKeywordRow }) {
  if (k.cited) {
    return (
      <span className="rounded border px-1.5 py-0.5 text-[10px] font-semibold bg-emerald-50 text-emerald-700 border-emerald-200">
        cites you ✓
      </span>
    );
  }
  if (k.aioTriggered) {
    return (
      <span
        className="rounded border px-1.5 py-0.5 text-[10px] font-semibold bg-amber-50 text-amber-700 border-amber-200"
        title={k.aioWinners.length > 0 ? `Cited instead: ${k.aioWinners.join(', ')}` : undefined}
      >
        AIO · not cited
      </span>
    );
  }
  if (k.paaPresent) {
    return (
      <span className="rounded border px-1.5 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 border-indigo-200">
        PAA
      </span>
    );
  }
  return (
    <span className="rounded border px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: 'var(--bg-2)', color: 'var(--text-3)', borderColor: 'var(--border)' }}>
      none captured
    </span>
  );
}

function pathOf2(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}

// Dual-series trend: average position (inverted — up is better) and top-10
// count. Scales derive from the observed values only.
function TrendSvg({ trend }: { trend: RankRollup['trend'] }) {
  const W = 720;
  const H = 170;
  const padL = 44;
  const padR = 20;
  const padT = 18;
  const padB = 28;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = trend.length;
  const x = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);

  const avgVals = trend.map((t) => t.avgPosition).filter((v): v is number => v !== null);
  const avgMax = avgVals.length > 0 ? Math.max(...avgVals) : 1;
  const avgMin = avgVals.length > 0 ? Math.min(...avgVals) : 0;
  const avgSpan = Math.max(avgMax - avgMin, 1);
  // Inverted: better (lower) positions plot higher.
  const yAvg = (v: number) => padT + ((v - avgMin) / avgSpan) * plotH;

  const topMax = Math.max(...trend.map((t) => t.top10), 1);
  const yTop = (v: number) => padT + (1 - v / topMax) * plotH;

  const avgPts = trend
    .map((t, i) => (t.avgPosition !== null ? `${x(i)},${yAvg(t.avgPosition)}` : null))
    .filter(Boolean)
    .join(' ');
  const topPts = trend.map((t, i) => `${x(i)},${yTop(t.top10)}`).join(' ');
  const last = trend[n - 1];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full mt-2" style={{ height: 170 }} preserveAspectRatio="none" aria-label="Ranking trend per scan">
      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="var(--border)" />
      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="var(--border)" />
      <text x={padL - 6} y={padT + 4} textAnchor="end" fontSize="10" fill="#9ca3af">#{avgMin}</text>
      <text x={padL - 6} y={H - padB} textAnchor="end" fontSize="10" fill="#9ca3af">#{avgMax}</text>
      <polyline points={topPts} fill="none" stroke="#059669" strokeWidth="2.5" strokeDasharray="5 4" />
      {trend.map((t, i) => (
        <circle key={`t${t.jobId}`} cx={x(i)} cy={yTop(t.top10)} r={i === n - 1 ? 4.5 : 3.5} fill="#059669">
          <title>{`${fmtDate(t.date)} — ${t.top10} keywords in top 10 (of ${t.tracked})`}</title>
        </circle>
      ))}
      {avgPts && <polyline points={avgPts} fill="none" stroke="#4f46e5" strokeWidth="2.5" />}
      {trend.map((t, i) =>
        t.avgPosition !== null ? (
          <circle key={`a${t.jobId}`} cx={x(i)} cy={yAvg(t.avgPosition)} r={i === n - 1 ? 4.5 : 3.5} fill="#4f46e5">
            <title>{`${fmtDate(t.date)} — average position ${t.avgPosition}`}</title>
          </circle>
        ) : null
      )}
      {/* Endpoint labels: avg below its point, top-10 above — the two series
          can converge at the same corner and the labels must never collide. */}
      {last.avgPosition !== null && (
        <text x={x(n - 1) - 8} y={yAvg(last.avgPosition) + 18} textAnchor="end" fontSize="11" fontWeight="700" fill="#4f46e5">
          #{last.avgPosition}
        </text>
      )}
      <text x={x(n - 1) - 8} y={yTop(last.top10) - 8} textAnchor="end" fontSize="11" fontWeight="700" fill="#059669">
        {last.top10} in top 10
      </text>
      {trend.map((t, i) => (
        <text key={`d${t.jobId}`} x={x(i)} y={H - padB + 16} textAnchor="middle" fontSize="10" fill="#9ca3af">
          {fmtDate(t.date)}
        </text>
      ))}
    </svg>
  );
}
