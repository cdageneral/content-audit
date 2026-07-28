'use client';

// ─────────────────────────────────────────────────────────────
//  OptimizeView — client surface for /projects/[id]/optimize.
//  Four crawl-forcing intent-bucket cards (Recency / Ranking /
//  Local / Comparison) act as a toggleable filter over BOTH the
//  optimization-progress list and the work queue. All counts are
//  real classifier output; the "likely AI fetch" figure applies
//  the shared isAiFetchLikely bar from lib/types.
//
//  ⚠️ Do NOT import from lib/hub here — it pulls the Neon driver
//  into the client bundle (same trap as lib/db/prompts; see the
//  URL-level model notes). Everything this component needs
//  arrives serialized via props, and small helpers are local.
// ─────────────────────────────────────────────────────────────

import { useState } from 'react';
import Link from 'next/link';
import OptimizedSummary from '@/components/OptimizedSummary';
import type { OptimizedRow } from '@/components/OptimizedSummary';
import { BUCKET_DESCRIPTIONS } from '@/lib/types';
import type { IntentBucket } from '@/lib/types';

const BUCKET_ICONS: Record<IntentBucket, string> = {
  recency: '⏱',
  ranking: '🏆',
  local: '📍',
  comparison: '⚖️',
};

export interface BucketCard {
  bucket: IntentBucket;
  label: string;
  count: number;
  fetchLikely: number;
}

export interface QueueEntry {
  url: string;
  pageId: string;
  grade: string;
  overall: number;
  weakest: { label: string; score: number }[];
  buckets: IntentBucket[] | null;
}

export default function OptimizeView({
  projectId,
  buckets,
  unclassified,
  optimizedRows,
  queue,
}: {
  projectId: string;
  buckets: BucketCard[];
  unclassified: number;
  optimizedRows: (OptimizedRow & { buckets: IntentBucket[] | null })[];
  queue: QueueEntry[];
}) {
  const [active, setActive] = useState<IntentBucket | null>(null);

  const inFilter = (b: IntentBucket[] | null) => active == null || (b ?? []).includes(active);
  const filteredOptimized = optimizedRows.filter((r) => inFilter(r.buckets));
  const filteredQueue = queue.filter((r) => inFilter(r.buckets));
  const activeLabel = active ? buckets.find((b) => b.bucket === active)?.label : null;
  const hiddenOptimized = optimizedRows.length - filteredOptimized.length;

  return (
    <>
      {/* ── Bucket cards ─────────────────────────────────── */}
      <div className="anim-fade-up grid grid-cols-2 lg:grid-cols-4 gap-3">
        {buckets.map((b) => {
          const on = active === b.bucket;
          return (
            <button
              key={b.bucket}
              type="button"
              onClick={() => setActive(on ? null : b.bucket)}
              aria-pressed={on}
              title={
                on
                  ? `Clear the ${b.label} filter`
                  : `Show only ${b.label} pages (${BUCKET_DESCRIPTIONS[b.bucket]})`
              }
              className="card relative p-3.5 text-left transition-all cursor-pointer"
              style={
                on
                  ? { borderColor: 'rgba(99,102,241,0.5)', boxShadow: '0 0 0 1px rgba(99,102,241,0.35)' }
                  : undefined
              }
            >
              {on && (
                <span className="absolute top-2.5 right-3 text-[10.5px] font-bold" style={{ color: '#4f46e5' }}>
                  ✕ clear
                </span>
              )}
              <p className="text-xs font-bold flex items-center gap-1.5" style={{ color: 'var(--text-1)' }}>
                <span aria-hidden="true">{BUCKET_ICONS[b.bucket]}</span> {b.label}
              </p>
              <p className="text-[21px] font-extrabold mt-1 leading-none" style={{ color: 'var(--text-1)', letterSpacing: '-0.02em' }}>
                {b.count}{' '}
                <span className="text-xs font-semibold" style={{ color: 'var(--text-3)' }}>
                  page{b.count === 1 ? '' : 's'}
                </span>
              </p>
              <p className="text-[11px] mt-1.5 leading-snug" style={{ color: 'var(--text-3)' }}>
                {BUCKET_DESCRIPTIONS[b.bucket]}
              </p>
              <p
                className="text-[10.5px] font-bold mt-1.5"
                style={{ color: b.fetchLikely > 0 ? '#4f46e5' : 'var(--text-3)' }}
              >
                {b.fetchLikely} likely AI fetch{b.fetchLikely > 0 ? ' ✓' : ''}
              </p>
            </button>
          );
        })}
      </div>

      {/* ── Filter status / unclassified note ─────────────── */}
      {(active || unclassified > 0) && (
        <p className="text-xs -mt-2" style={{ color: 'var(--text-3)' }}>
          {active && (
            <>
              Filtering to <span className="font-bold" style={{ color: '#4f46e5' }}>{activeLabel}</span> pages —{' '}
              <button
                type="button"
                onClick={() => setActive(null)}
                className="font-semibold hover:underline cursor-pointer"
                style={{ color: '#4f46e5' }}
              >
                clear
              </button>
              {unclassified > 0 && ' · '}
            </>
          )}
          {unclassified > 0 && (
            <>
              {unclassified} page{unclassified === 1 ? '' : 's'} not yet classified into buckets —{' '}
              <Link href={`/projects/${projectId}/pages`} className="font-semibold hover:underline" style={{ color: '#4f46e5' }}>
                run classification from Pages →
              </Link>
            </>
          )}
        </p>
      )}

      {/* ── Optimization progress ─────────────────────────── */}
      {filteredOptimized.length > 0 && (
        <div className="anim-fade-up stagger-1">
          <p className="section-label">
            Optimization progress — projected impact
            {active && hiddenOptimized > 0 && (
              <span className="ml-2 font-normal normal-case tracking-normal" style={{ color: 'var(--text-3)' }}>
                ({hiddenOptimized} non-{activeLabel} page{hiddenOptimized === 1 ? '' : 's'} hidden)
              </span>
            )}
          </p>
          <OptimizedSummary projectId={projectId} rows={filteredOptimized} />
        </div>
      )}
      {active && filteredOptimized.length === 0 && optimizedRows.length > 0 && (
        <p className="text-sm" style={{ color: 'var(--text-3)' }}>
          No {activeLabel} pages have optimization work yet.
        </p>
      )}

      {/* ── Work queue ────────────────────────────────────── */}
      <div className="anim-fade-up stagger-2 card overflow-hidden">
        <div className="px-5 pt-4 pb-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
            Work queue
            {filteredQueue.length > 0
              ? ` — ${filteredQueue.length}${active ? ` ${activeLabel}` : ''} page${filteredQueue.length === 1 ? '' : 's'}`
              : ''}
          </p>
          <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
            Weakest first. Each page&apos;s two lowest dimension scores are shown — that&apos;s where the
            workbench will focus.
          </p>
        </div>
        {filteredQueue.length === 0 ? (
          <p className="px-5 py-6 text-sm" style={{ color: 'var(--text-3)' }}>
            {active
              ? `No ${activeLabel} pages in the work queue${queue.length > 0 ? ' — clear the filter to see all pages' : ''}.`
              : 'Every audited page has optimization work in progress — nice. Check the progress list above, or re-run the audit to refresh baselines.'}
          </p>
        ) : (
          filteredQueue.map((s) => (
            <div
              key={s.pageId}
              className="flex items-center gap-4 px-5 py-3"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <span
                className="inline-flex items-center justify-center text-[11px] font-bold rounded px-2 py-0.5 flex-shrink-0"
                style={{
                  background: `${gradeColor(s.grade)}1f`,
                  color: gradeColor(s.grade),
                  border: `1px solid ${gradeColor(s.grade)}40`,
                }}
              >
                {s.grade} · {s.overall}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium truncate" style={{ color: 'var(--text-1)' }} title={s.url}>
                  {pathOf(s.url)}
                </p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>
                  {s.weakest.map((w) => `${w.label} ${w.score}`).join(' · ')}
                </p>
              </div>
              <Link
                href={`/projects/${projectId}/optimize/${s.pageId}`}
                className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg hover:underline"
                style={{ color: '#4f46e5' }}
              >
                Open workbench →
              </Link>
            </div>
          ))
        )}
      </div>
    </>
  );
}

function gradeColor(g: string) {
  return g === 'A' ? '#059669' : g === 'B' ? '#2563eb' : g === 'C' ? '#d97706' : g === 'D' ? '#ea580c' : '#dc2626';
}

function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname === '/' ? u.hostname : u.pathname;
  } catch {
    return url;
  }
}
