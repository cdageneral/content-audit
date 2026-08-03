'use client';

// ─────────────────────────────────────────────────────────────
//  ProjectRail — the project-scoped left navigation (app shell).
//  Rendered by app/projects/[id]/layout.tsx for every route under
//  /projects/[id], including the Optimize workbench. Run Audit is
//  pinned at the top as an ACTION (not a nav row) so a scan can be
//  started from any section. Then Setup (Brand & Context — configure
//  once, feeds the AI), then the workflow in order: Overview →
//  Pages → Optimize → AI Visibility → Competitors, then the output
//  surfaces (Reports, Settings). Optimize sits directly under Pages
//  because that is the actual work loop — find weak pages, fix them;
//  Visibility and Competitors are the diagnostic surfaces behind it.
//  The dashboard ("/") stays rail-free — it's a picker, not a
//  workspace.
//
//  On < lg viewports the rail collapses to a horizontal tab bar
//  under the top nav (same links, same active logic).
// ─────────────────────────────────────────────────────────────

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import RailRunButton from '@/components/RailRunButton';

interface RailProps {
  projectId: string;
  name: string;
  domain: string;
  pageCount: number;
  needsWork: number;
  competitorCount: number;
  /** TRUE when a brand profile with at least one active section exists. */
  brandActive: boolean;
  /** 'on' = scheduled scans enabled · 'paused' = auto-paused · 'off' = none. */
  scheduleState: 'off' | 'on' | 'paused';
}

interface RailItem {
  key: string;
  label: string;
  href: string;
  /** exact = only the base path is active; prefix also matches subroutes */
  match: 'exact' | 'prefix';
  icon: React.ReactNode;
  badge?: { text: string; warn?: boolean } | null;
}

const ic = (paths: React.ReactNode) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    className="w-[17px] h-[17px] flex-shrink-0 opacity-85"
    aria-hidden="true"
  >
    {paths}
  </svg>
);

export default function ProjectRail({
  projectId,
  name,
  domain,
  pageCount,
  needsWork,
  competitorCount,
  brandActive,
  scheduleState,
}: RailProps) {
  const pathname = usePathname() || '';
  const base = `/projects/${projectId}`;

  const setup: RailItem[] = [
    {
      key: 'brand',
      label: 'Brand & Context',
      href: `${base}/brand`,
      match: 'prefix',
      icon: ic(
        // Sparkle — brand voice/context feeding the AI.
        <>
          <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z" />
          <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9Z" />
        </>
      ),
      // "On" when the profile is live so it's visible at a glance that AI
      // writing is brand-steered; no badge before setup (the empty state on
      // the page itself is the call to action).
      badge: brandActive ? { text: 'On' } : null,
    },
    {
      key: 'schedule',
      label: 'Scan Schedule',
      href: `${base}/schedule`,
      match: 'prefix',
      icon: ic(
        // Clock — automatic re-scans on a cadence.
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </>
      ),
      // "Paused" (amber) must be visible at a glance — it means scheduled
      // scans stopped themselves and are waiting on a human.
      badge:
        scheduleState === 'paused'
          ? { text: 'Paused', warn: true }
          : scheduleState === 'on'
            ? { text: 'On' }
            : null,
    },
  ];

  const workflow: RailItem[] = [
    {
      key: 'overview',
      label: 'Overview',
      href: base,
      match: 'exact',
      icon: ic(
        <>
          <rect x="3" y="3" width="7" height="9" rx="1.5" />
          <rect x="14" y="3" width="7" height="5" rx="1.5" />
          <rect x="14" y="12" width="7" height="9" rx="1.5" />
          <rect x="3" y="16" width="7" height="5" rx="1.5" />
        </>
      ),
      badge: null,
    },
    {
      key: 'pages',
      label: 'Pages',
      href: `${base}/pages`,
      match: 'prefix',
      icon: ic(
        <>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </>
      ),
      badge: pageCount > 0 ? { text: String(pageCount) } : null,
    },
    {
      key: 'optimize',
      label: 'Optimize',
      href: `${base}/optimize`,
      match: 'prefix',
      icon: ic(
        <>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </>
      ),
      badge: needsWork > 0 ? { text: String(needsWork), warn: true } : null,
    },
    {
      key: 'visibility',
      // "Visibility" (was "AI Visibility", 2026-07-31): the section now tells
      // one story across two channels — AI Answers + Google Rankings tabs.
      label: 'Visibility',
      href: `${base}/visibility`,
      match: 'prefix',
      icon: ic(
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </>
      ),
      badge: null,
    },
    {
      key: 'competitors',
      label: 'Competitors',
      href: `${base}/competitors`,
      match: 'prefix',
      icon: ic(
        <>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </>
      ),
      badge: competitorCount > 0 ? { text: String(competitorCount) } : null,
    },
    {
      // Last stop in the workflow on purpose: Business Impact synthesizes
      // everything upstream (rankings, demand, prompt citations) into the
      // executive story — the page you open in front of a CMO.
      key: 'impact',
      label: 'Business Impact',
      href: `${base}/impact`,
      match: 'prefix',
      icon: ic(
        // Trending-up — visibility translated into business results.
        <>
          <path d="M3 17l6-6 4 4 8-8" />
          <path d="M14 7h7v7" />
        </>
      ),
      badge: null,
    },
  ];

  const output: RailItem[] = [
    {
      key: 'reports',
      label: 'Reports',
      href: `${base}/reports`,
      match: 'prefix',
      icon: ic(
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5" />
          <path d="M12 15V3" />
        </>
      ),
      badge: null,
    },
    {
      key: 'settings',
      label: 'Settings',
      href: `${base}/settings`,
      match: 'prefix',
      icon: ic(
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v2.6M12 19.4V22M4.9 4.9l1.9 1.9M17.2 17.2l1.9 1.9M2 12h2.6M19.4 12H22M4.9 19.1l1.9-1.9M17.2 6.8l1.9-1.9" />
        </>
      ),
      badge: null,
    },
  ];

  const isActive = (item: RailItem) =>
    item.match === 'exact'
      ? pathname === item.href
      : pathname === item.href || pathname.startsWith(item.href + '/');

  const linkClass = (active: boolean) =>
    `relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13.5px] transition-colors ${
      active ? 'font-semibold' : ''
    }`;
  const linkStyle = (active: boolean): React.CSSProperties =>
    active
      ? { background: 'rgba(99,102,241,0.09)', color: 'var(--indigo-dim, #4f46e5)' }
      : { color: 'var(--text-2)' };

  const renderItem = (item: RailItem) => {
    const active = isActive(item);
    return (
      <Link key={item.key} href={item.href} className={linkClass(active)} style={linkStyle(active)}>
        {active && (
          <span
            aria-hidden="true"
            className="absolute -left-2.5 top-[7px] bottom-[7px] w-[3px] rounded"
            style={{ background: '#6366f1' }}
          />
        )}
        {item.icon}
        <span>{item.label}</span>
        {item.badge && (
          <span
            className="ml-auto rounded-full px-1.5 min-w-[20px] h-[18px] inline-flex items-center justify-center text-[10.5px] font-bold"
            style={
              item.badge.warn
                ? { background: 'rgba(217,119,6,0.14)', color: '#d97706' }
                : { background: 'var(--bg-3)', color: 'var(--text-2)' }
            }
          >
            {item.badge.text}
          </span>
        )}
      </Link>
    );
  };

  return (
    <>
      {/* ── Desktop rail ── */}
      <nav
        className="hidden lg:flex w-[232px] flex-shrink-0 flex-col gap-0.5 px-2.5 py-3.5 border-r sticky top-[65px] self-start h-[calc(100vh-65px)] overflow-y-auto"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        aria-label="Project sections"
      >
        <Link
          href="/"
          title="Switch project"
          className="flex items-center justify-between gap-2 rounded-[10px] px-3 py-2.5 mb-2.5 border transition-colors hover:border-slate-300"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)' }}
        >
          <span className="min-w-0">
            <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--text-1)' }}>
              {name}
            </span>
            <span className="block text-[11px] truncate" style={{ color: 'var(--text-3)' }}>
              {domain.replace(/^https?:\/\//, '')}
              {pageCount > 0 ? ` · ${pageCount} page${pageCount === 1 ? '' : 's'}` : ''}
            </span>
          </span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8a94a6" strokeWidth={2.5} className="flex-shrink-0">
            <path d="M7 9l5-5 5 5M7 15l5 5 5-5" />
          </svg>
        </Link>

        {/* Action, pinned above the nav groups — starting a scan should not
            require navigating back to the Overview first. */}
        <RailRunButton projectId={projectId} />

        <p className="px-3 pt-1 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--text-3)' }}>
          Setup
        </p>
        {setup.map(renderItem)}

        <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--text-3)' }}>
          Workflow
        </p>
        {workflow.map(renderItem)}

        <p className="px-3 pt-3 pb-1 text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: 'var(--text-3)' }}>
          Output
        </p>
        {output.map(renderItem)}
      </nav>

      {/* ── Mobile / tablet tab bar ── */}
      <nav
        className="lg:hidden sticky top-[65px] z-40 flex items-center gap-1 overflow-x-auto px-3 py-2 border-b"
        style={{ background: 'var(--bg-1)', borderColor: 'var(--border)' }}
        aria-label="Project sections"
      >
        <RailRunButton projectId={projectId} compact />
        {[...setup, ...workflow, ...output].map((item) => {
          const active = isActive(item);
          return (
            <Link
              key={item.key}
              href={item.href}
              className="whitespace-nowrap rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              style={
                active
                  ? { background: 'rgba(99,102,241,0.09)', color: '#4f46e5' }
                  : { color: 'var(--text-2)' }
              }
            >
              {item.label}
              {item.badge ? ` · ${item.badge.text}` : ''}
            </Link>
          );
        })}
      </nav>
    </>
  );
}
