'use client';

// ─────────────────────────────────────────────────────────────
//  BrandCheck — the workbench's deterministic brand-alignment
//  strip. Runs lib/brand/lint (pure string checks: banned terms,
//  heading case, exclamations, Flesch–Kincaid reading grade) on
//  the CURRENT editor content. No model call, no modeled verdict
//  — every row is a reproducible measurement, which is why there
//  is no "tone match" row. Collapsed by default to a one-line
//  summary; expands to the findings.
// ─────────────────────────────────────────────────────────────

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { runBrandLint } from '@/lib/brand/lint';
import { summarizeBrandContext, type BrandProfile } from '@/lib/brand/types';

interface Props {
  projectId: string;
  profile: BrandProfile;
  title: string;
  bodyMd: string;
}

export default function BrandCheck({ projectId, profile, title, bodyMd }: Props) {
  const [open, setOpen] = useState(false);
  const summary = summarizeBrandContext(profile);
  const lint = useMemo(() => runBrandLint(profile, title, bodyMd), [profile, title, bodyMd]);

  if (!summary.active) return null;

  const chipStyle =
    lint.warnCount > 0
      ? { background: 'rgba(217,119,6,0.12)', color: '#b45309', border: '1px solid rgba(217,119,6,0.3)' }
      : { background: 'rgba(5,150,105,0.09)', color: '#047857', border: '1px solid rgba(5,150,105,0.25)' };

  return (
    <div className="card px-4 py-2.5">
      <div className="flex items-center gap-2.5 flex-wrap">
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
          style={{ background: 'rgba(111,28,254,0.08)', color: '#6f1cfe', border: '1px solid rgba(111,28,254,0.22)' }}
          title="This project's brand profile is injected into AI rewrites and generated sections"
        >
          ✦ Brand context: ON · {summary.sectionsOn} of {summary.sectionsTotal} sections
        </span>

        {lint.findings.length > 0 && (
          <button
            onClick={() => setOpen(!open)}
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
            style={chipStyle}
          >
            {lint.warnCount > 0
              ? `⚠ Brand check: ${lint.warnCount} flag${lint.warnCount > 1 ? 's' : ''}`
              : '✓ Brand check: clean'}
            <span className="opacity-70">{open ? '▴' : '▾'}</span>
          </button>
        )}

        <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
          deterministic checks on the current editor content — tone itself isn&apos;t machine-checkable
        </span>

        <Link
          href={`/projects/${projectId}/brand`}
          className="ml-auto text-[11.5px] font-semibold hover:underline"
          style={{ color: '#4f46e5' }}
        >
          Edit profile →
        </Link>
      </div>

      {open && lint.findings.length > 0 && (
        <div className="mt-2.5 pt-2.5 border-t space-y-1.5" style={{ borderColor: 'var(--border)' }}>
          {lint.findings.map((f) => (
            <div key={f.id} className="flex items-start gap-2 text-[12.5px]">
              <span
                className="font-bold flex-shrink-0 w-4 text-center"
                style={{ color: f.status === 'pass' ? '#059669' : '#d97706' }}
              >
                {f.status === 'pass' ? '✓' : '!'}
              </span>
              <span style={{ color: 'var(--text-2)' }}>
                {f.label}
                {f.detail && (
                  <span style={{ color: 'var(--text-3)' }}> — {f.detail}</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
