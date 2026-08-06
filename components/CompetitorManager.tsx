'use client';

/**
 * CompetitorManager — a top-nav button + modal for adding / removing the
 * competitors tracked on a project. Replaces the inline "Tracked competitors"
 * and "Add a competitor" cards that used to sit on the project hub. After any
 * change it prompts the user to re-run the scan so the comparison updates.
 *
 * Add:    POST   /api/projects/[id]/competitors  { name, url, scopePrefix? }
 * Remove: DELETE /api/projects/[id]/competitors  { competitorId }
 * Run:    POST   /api/projects/[id]/run          { includeClient }
 * Scope:  GET    /api/projects/[id]/run          → clientRun freshness
 *
 * The modal has a sticky footer with an explicit Close and a Run button that
 * starts the scan and closes in one action. Before that footer existed the
 * only visible way out was the × (backdrop-click and Escape worked but were
 * undiscoverable), and the "re-run the scan" notice pointed at a button on
 * a page hidden behind the modal — a dead end.
 *
 * RUN SCOPE. Two modes, because a full audit re-crawls and re-scores the
 * CLIENT site too — real money per page — which adding a competitor doesn't
 * need:
 *   • Competitors only — audits just the competitor sites and compares them
 *     against the client's stored scores. Offered ONLY while the client's
 *     last completed scan is within staleAfterDays (30), because the matrix
 *     compares fresh competitor numbers against those stored client numbers;
 *     past the window the two sides aren't the same measurement any more.
 *   • Full audit — client + competitors, the old behaviour, always available.
 * The GET above decides which modes are offered; the POST re-checks server-
 * side, so this component's job is to EXPLAIN the choice, not to enforce it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';

const COMPETITOR_COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#0284c7'];

interface Competitor {
  id: string;
  name: string;
  url: string;
  colorIndex: number;
  latestScore: number | null;
  scoreDelta: number | null;
}

interface ClientRun {
  lastCompletedAt: string | null;
  ageDays: number | null;
  /** True = competitors-only is refused (too old, or never scanned). */
  stale: boolean;
  staleAfterDays: number;
}

type RunScope = 'competitors' | 'full';

/** "3 days ago" / "today" — the client's last scan, in words. */
function ageLabel(ageDays: number | null): string {
  if (ageDays == null) return 'never scanned';
  if (ageDays === 0) return 'today';
  if (ageDays === 1) return 'yesterday';
  return `${ageDays} days ago`;
}

export default function CompetitorManager({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setMounted(true); }, []);
  const [competitors, setCompetitors] = useState<Competitor[]>([]);
  const [count, setCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);

  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [scopePrefix, setScopePrefix] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState('');
  const [clientName, setClientName] = useState('the client site');
  const [clientRun, setClientRun] = useState<ClientRun | null>(null);
  const [scope, setScope] = useState<RunScope>('full');
  const scopeDefaulted = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [projRes, runRes] = await Promise.all([
        fetch(`/api/projects/${projectId}`, { cache: 'no-store' }),
        fetch(`/api/projects/${projectId}/run`, { cache: 'no-store' }),
      ]);
      const data = await projRes.json().catch(() => ({}));
      const list = (data?.project?.competitors ?? []) as Competitor[];
      setCompetitors(list);
      setCount(list.length);
      if (data?.project?.clientName) setClientName(String(data.project.clientName));

      const runData = await runRes.json().catch(() => ({}));
      const cr = (runData?.clientRun ?? null) as ClientRun | null;
      setClientRun(cr);
      // Pick the default ONCE. load() also runs after every add/remove, and
      // re-deriving here would silently flip a choice the user had already
      // made. Falls back to the full audit, which is always available.
      if (!scopeDefaulted.current) {
        scopeDefaulted.current = true;
        setScope(cr && !cr.stale && list.length > 0 ? 'competitors' : 'full');
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { load(); }, [load]);

  // Lock body scroll + close on Escape while the modal is open.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = ''; window.removeEventListener('keydown', onKey); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    if (running) return; // don't yank the modal out from under an in-flight start
    setOpen(false);
    setError('');
    setRunError('');
    if (dirty) router.refresh(); // sync the page (matrix, run button) behind the modal
  }

  /**
   * Start a scan straight from the modal, then close.
   *
   * Navigates to the project Overview on success for the same reason
   * RailRunButton does: Overview is the only surface that renders
   * LiveAuditBanner and the last-run-failure alert, so starting a run and
   * leaving the user on Competitors/Settings looks like nothing happened.
   *
   * startProjectRun supersedes any active jobs for the project, so this is
   * safe to press while an older run is still in flight — same semantics as
   * every other Run Audit button. (A competitors-only run supersedes only
   * COMPETITOR jobs, so it can't kill an in-flight client scan.)
   */
  async function runAudit() {
    if (running) return;
    setRunning(true);
    setRunError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ includeClient: effectiveScope !== 'competitors' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // The route returns an actionable message (403 vs no sitemap) — show
        // it verbatim and keep the modal open so it can actually be read.
        setRunError(data.error ?? 'Failed to start audit');
        return;
      }
      setOpen(false);
      setDirty(false);
      router.push(`/projects/${projectId}`);
      router.refresh();
    } catch {
      setRunError('Network error — please try again');
    } finally {
      setRunning(false);
    }
  }

  function isValidUrl(u: string) { try { new URL(u); return true; } catch { return false; } }
  const canSubmit = !!name.trim() && isValidUrl(url) && !adding;

  // ── Run-scope availability ────────────────────────────────
  // Competitors-only needs BOTH something to audit and a client scan recent
  // enough to compare it against. Anything else falls back to the full audit,
  // which is never blocked. effectiveScope is what actually gets sent, so a
  // stale reading can't leak a competitors-only request past the UI.
  const competitorsOnlyAllowed = !!clientRun && !clientRun.stale && competitors.length > 0;
  const effectiveScope: RunScope = competitorsOnlyAllowed ? scope : 'full';

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setAdding(true); setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/competitors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), url: url.trim(), scopePrefix: scopePrefix.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error ?? 'Failed to add competitor'); return; }
      setName(''); setUrl(''); setScopePrefix(''); setDirty(true);
      await load();
    } catch {
      setError('Network error — please try again');
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string) {
    setRemovingId(id); setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/competitors`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ competitorId: id }),
      });
      if (!res.ok) { setError('Failed to remove competitor'); return; }
      setDirty(true);
      await load();
    } catch {
      setError('Network error — please try again');
    } finally {
      setRemovingId(null);
    }
  }

  const label = 'block text-xs font-medium mb-1.5';

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="nav-link px-3 py-1.5 rounded-lg text-sm ml-1 inline-flex items-center gap-1.5"
        title="Add or edit competitors tracked on this project"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
        Competitors
        {count != null && count > 0 && (
          <span
            className="inline-flex items-center justify-center text-[11px] font-semibold rounded-full px-1.5 min-w-[18px] h-[18px]"
            style={{ background: 'rgba(99,102,241,0.15)', color: '#4f46e5' }}
          >
            {count}
          </span>
        )}
      </button>

      {open && mounted && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-8 overflow-y-auto"
          style={{ background: 'rgba(15,23,42,0.55)', backdropFilter: 'blur(2px)' }}
          onClick={close}
        >
          <div
            className="card w-full max-w-lg my-auto"
            style={{ padding: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
              <div>
                <h2 className="text-lg font-semibold" style={{ color: 'var(--text-1)' }}>Competitors</h2>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-3)' }}>Add or remove the sites compared against this project.</p>
              </div>
              <button onClick={close} aria-label="Close" className="rounded-lg p-1.5" style={{ color: 'var(--text-3)' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
              </button>
            </div>

            <div className="px-6 py-5 space-y-5">
              {/* Re-run prompt after any change */}
              {dirty && (
                <div className="rounded-lg px-3 py-2.5 text-xs anim-fade-in flex items-start gap-2"
                  style={{ background: 'rgba(245,158,11,0.10)', border: '1px solid rgba(245,158,11,0.3)', color: '#b45309' }}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="flex-shrink-0 mt-px"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
                  <span><strong>Saved.</strong> Scores won&rsquo;t reflect this change until the next scan — pick a run scope below and start it from here.</span>
                </div>
              )}

              {/* Tracked list */}
              <div>
                <p className="section-label">Tracked competitors</p>
                {loading && competitors.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--text-3)' }}>Loading…</p>
                ) : competitors.length === 0 ? (
                  <p className="text-sm" style={{ color: 'var(--text-3)' }}>No competitors tracked yet. Add one below to start comparing.</p>
                ) : (
                  <div className="space-y-2">
                    {competitors.map((c) => (
                      <div key={c.id} className="flex items-center gap-3 p-3 rounded-lg" style={{ background: 'var(--bg-2)' }}>
                        <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: COMPETITOR_COLORS[c.colorIndex] ?? '#64748b' }} />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate" style={{ color: 'var(--text-1)' }}>{c.name}</p>
                          <p className="text-xs font-mono truncate" style={{ color: 'var(--text-3)' }}>{c.url.replace(/^https?:\/\//, '')}</p>
                        </div>
                        {c.latestScore != null && (
                          <span className="text-sm font-bold flex-shrink-0" style={{ color: 'var(--text-2)' }}>{c.latestScore}</span>
                        )}
                        <button
                          onClick={() => remove(c.id)}
                          disabled={removingId === c.id}
                          title={`Remove ${c.name}`}
                          className="text-xs px-2 py-1 rounded-md flex-shrink-0"
                          style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.25)', color: '#dc2626', cursor: 'pointer' }}
                        >
                          {removingId === c.id ? '…' : 'Remove'}
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Add form */}
              <form onSubmit={add} className="space-y-3 pt-1" style={{ borderTop: '1px solid var(--border)', paddingTop: '1.25rem' }}>
                <p className="section-label">Add a competitor</p>
                <div>
                  <label className={label} style={{ color: 'var(--text-3)' }}>Competitor name</label>
                  <input className="dark-input" placeholder="Acme Competitor" value={name} onChange={(e) => setName(e.target.value)} />
                </div>
                <div>
                  <label className={label} style={{ color: 'var(--text-3)' }}>Website URL</label>
                  <input type="url" className="dark-input" placeholder="https://competitor.com" value={url} onChange={(e) => setUrl(e.target.value)} />
                </div>
                <div>
                  <label className={label} style={{ color: 'var(--text-3)' }}>Scope prefix <span style={{ fontWeight: 400 }}>(optional)</span></label>
                  <input className="dark-input" placeholder="/docs" value={scopePrefix} onChange={(e) => setScopePrefix(e.target.value)} />
                </div>
                {error && (
                  <div className="rounded-lg px-3 py-2 text-xs" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#dc2626' }}>{error}</div>
                )}
                <button type="submit" disabled={!canSubmit} className="btn-primary w-full text-sm">
                  {adding ? (
                    <span className="flex items-center justify-center gap-2"><span className="spinner" style={{ width: 13, height: 13 }} />Adding…</span>
                  ) : '+ Add competitor'}
                </button>
                <p className="text-xs" style={{ color: 'var(--text-3)' }}>Competitor audits are capped at 50 pages per run.</p>
              </form>
            </div>

            {/* Footer — an explicit way out, and a way to act on the notice
                above without hunting for a button behind the modal. */}
            <div className="px-6 py-4" style={{ borderTop: '1px solid var(--border)' }}>
              {runError && (
                <div
                  role="alert"
                  className="mb-3 rounded-lg px-3 py-2 text-xs"
                  style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.35)', color: '#b91c1c', lineHeight: 1.45 }}
                >
                  {runError}
                </div>
              )}
              {/* ── Run scope ──────────────────────────────────
                  A full audit re-crawls and re-scores the client site as
                  well, which is real spend per page. Adding a competitor
                  doesn't need that — so offer the cheap mode, but ONLY
                  while the stored client scores it compares against are
                  still recent. The note is the point: the user has to be
                  able to see what each mode measures and why one of them
                  sometimes isn't on offer. */}
              <div className="mb-3 rounded-lg px-3 py-3" style={{ background: 'var(--bg-2)' }}>
                <p className="section-label" style={{ marginBottom: 8 }}>Run scope</p>

                <label
                  className="flex items-start gap-2.5 text-xs"
                  style={{ cursor: competitorsOnlyAllowed ? 'pointer' : 'not-allowed', opacity: competitorsOnlyAllowed ? 1 : 0.5 }}
                >
                  <input
                    type="radio"
                    name="run-scope"
                    className="mt-0.5 flex-shrink-0"
                    checked={effectiveScope === 'competitors'}
                    disabled={!competitorsOnlyAllowed || running}
                    onChange={() => setScope('competitors')}
                  />
                  <span>
                    <span className="font-semibold" style={{ color: 'var(--text-1)' }}>Competitors only</span>
                    <span style={{ color: 'var(--text-3)' }}>
                      {' '}— crawls just the competitor sites and compares them against{' '}
                      {clientName}&rsquo;s stored scores. Cheaper: your own pages aren&rsquo;t re-crawled or re-scored.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2.5 text-xs mt-2" style={{ cursor: running ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="radio"
                    name="run-scope"
                    className="mt-0.5 flex-shrink-0"
                    checked={effectiveScope === 'full'}
                    disabled={running}
                    onChange={() => setScope('full')}
                  />
                  <span>
                    <span className="font-semibold" style={{ color: 'var(--text-1)' }}>Full audit</span>
                    <span style={{ color: 'var(--text-3)' }}>
                      {' '}— {clientName} and every competitor, all measured in this run.
                    </span>
                  </span>
                </label>

                {/* Why the cheap mode is or isn't available. Never silent:
                    an unexplained disabled radio reads as a bug. */}
                {clientRun && (
                  <p className="text-[11px] mt-2.5 pt-2.5" style={{ borderTop: '1px solid var(--border)', color: competitorsOnlyAllowed ? 'var(--text-3)' : '#b45309', lineHeight: 1.5 }}>
                    {competitorsOnlyAllowed ? (
                      <>
                        {clientName} was last scanned <strong>{ageLabel(clientRun.ageDays)}</strong>. Competitors-only
                        reuses that scan, so it stays available for {clientRun.staleAfterDays} days after it — past
                        that the two sides of the comparison are no longer the same measurement and only a full audit
                        is offered.
                      </>
                    ) : competitors.length === 0 ? (
                      <>Competitors-only needs at least one tracked competitor. Add one above.</>
                    ) : clientRun.ageDays == null ? (
                      <>
                        <strong>Competitors-only isn&rsquo;t available yet:</strong> {clientName} has no completed scan,
                        so there are no stored scores to compare competitors against. Run the full audit first.
                      </>
                    ) : (
                      <>
                        <strong>Competitors-only isn&rsquo;t available:</strong> {clientName} was last scanned{' '}
                        {ageLabel(clientRun.ageDays)}, past the {clientRun.staleAfterDays}-day limit. Fresh competitor
                        scores compared against stale client scores would read as a gap that isn&rsquo;t real, so this
                        run includes {clientName} too.
                      </>
                    )}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between gap-3">
                <span className="text-xs" style={{ color: 'var(--text-3)' }}>
                  {effectiveScope === 'competitors'
                    ? `Runs ${competitors.length} competitor${competitors.length === 1 ? '' : 's'} · up to 50 pages each`
                    : `Runs ${clientName} + ${competitors.length} competitor${competitors.length === 1 ? '' : 's'}`}
                </span>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    type="button"
                    onClick={close}
                    disabled={running}
                    className="text-sm px-4 py-2 rounded-lg"
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--border)',
                      color: 'var(--text-2)',
                      cursor: running ? 'not-allowed' : 'pointer',
                      opacity: running ? 0.5 : 1,
                    }}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={runAudit}
                    disabled={running}
                    title={
                      effectiveScope === 'competitors'
                        ? 'Audit the competitor sites only, then close this window'
                        : 'Audit the client site and all competitors, then close this window'
                    }
                    className="btn-primary text-sm flex items-center gap-2"
                    style={{ padding: '8px 16px' }}
                  >
                    {running ? (
                      <>
                        <span className="spinner" style={{ width: 13, height: 13 }} />
                        Starting&hellip;
                      </>
                    ) : (
                      <>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
                          <polygon points="5 3 19 12 5 21 5 3" />
                        </svg>
                        {effectiveScope === 'competitors' ? 'Run Competitors' : 'Run Full Audit'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
