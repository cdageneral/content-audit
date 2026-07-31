'use client';

// ─────────────────────────────────────────────────────────────
//  VisibilityTabs — sub-navigation for the Visibility section.
//  One story, two channels: AI Answers (the original AI
//  Visibility surface) · Google Rankings · Combined (rank × AI
//  citation quadrants). Rendered by visibility/layout.tsx above
//  all three tab routes.
// ─────────────────────────────────────────────────────────────

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export default function VisibilityTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname() || '';
  const base = `/projects/${projectId}/visibility`;
  const tabs: { href: string; label: string; exact: boolean; isNew?: boolean }[] = [
    { href: base, label: 'AI Answers', exact: true },
    { href: `${base}/rankings`, label: 'Google Rankings', exact: false, isNew: true },
    { href: `${base}/combined`, label: 'Combined', exact: false, isNew: true },
  ];

  return (
    <div
      className="flex items-center gap-1 border-b overflow-x-auto"
      style={{ borderColor: 'var(--border)' }}
      role="tablist"
      aria-label="Visibility views"
    >
      {tabs.map((t) => {
        const active = t.exact
          ? pathname === t.href
          : pathname === t.href || pathname.startsWith(t.href + '/');
        return (
          <Link
            key={t.href}
            href={t.href}
            role="tab"
            aria-selected={active}
            className="flex items-center gap-1.5 whitespace-nowrap px-4 py-2.5 text-[13.5px] font-semibold -mb-px border-b-2 transition-colors"
            style={
              active
                ? { color: '#4f46e5', borderColor: '#4f46e5' }
                : { color: 'var(--text-3)', borderColor: 'transparent' }
            }
          >
            {t.label}
            {t.isNew && (
              <span
                className="rounded-full px-1.5 py-px text-[9.5px] font-bold"
                style={{ background: 'rgba(111,28,254,0.1)', color: '#6f1cfe' }}
              >
                NEW
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}
