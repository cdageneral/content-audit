'use client';

/**
 * NavActions — right-side action(s) in the global top nav that depend on the
 * current route. On a project page (/projects/<uuid>) it shows:
 *   - a "Competitors" button (add / edit the tracked competitor set), always;
 *   - a "Download Assessment" button, once the project has a completed run.
 */

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import CompetitorManager from './CompetitorManager';

export default function NavActions() {
  const pathname = usePathname() || '';
  const match = pathname.match(/^\/projects\/([0-9a-fA-F-]{36})(?:\/|$)/);
  const projectId = match?.[1];
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!projectId) return;
    let alive = true;
    fetch(`/api/projects/${projectId}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (alive && d?.project?.latestScore != null) setReady(true); })
      .catch(() => {});
    return () => { alive = false; };
  }, [projectId]);

  if (!projectId) return null;

  return (
    <>
      <CompetitorManager projectId={projectId} />
      {ready && (
        <a
          href={`/api/projects/${projectId}/report`}
          className="btn-primary ml-2 inline-flex items-center gap-1.5 text-sm px-4 py-1.5"
          title="Download the client-ready PDF assessment from the latest completed run"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2}>
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Download Assessment
        </a>
      )}
    </>
  );
}
