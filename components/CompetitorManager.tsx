'use client';

/**
 * CompetitorManager — a top-nav button + modal for adding / removing the
 * competitors tracked on a project. Replaces the inline "Tracked competitors"
 * and "Add a competitor" cards that used to sit on the project hub. After any
 * change it prompts the user to re-run the scan so the comparison updates.
 *
 * Add:    POST   /api/projects/[id]/competitors  { name, url, scopePrefix? }
 * Remove: DELETE /api/projects/[id]/competitors  { competitorId }
 */

import { useCallback, useEffect, useState } from 'react';
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

export default function CompetitorManager({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
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

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const list = (data?.project?.competitors ?? []) as Competitor[];
      setCompetitors(list);
      setCount(list.length);
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
    setOpen(false);
    setError('');
    if (dirty) router.refresh(); // sync the page (matrix, run button) behind the modal
  }

  function isValidUrl(u: string) { try { new URL(u); return true; } catch { return false; } }
  const canSubmit = !!name.trim() && isValidUrl(url) && !adding;

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

      {open && (
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
                  <span><strong>Saved.</strong> Re-run the scan (<strong>Run All</strong> on the project) to score the updated competitor set.</span>
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
          </div>
        </div>
      )}
    </>
  );
}
