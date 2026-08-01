'use client';

/**
 * AdminUsageTab — super_admin "API Usage" tab on /admin.
 *
 * Shows the real recorded API-call ledger two ways, from one server-side
 * project × provider matrix so the two can never disagree:
 *   • Group by Project → project totals, a per-API split inside each project,
 *     then each audit run, then each individual call.
 *   • Group by API     → provider totals, then which projects spent it, then
 *     each individual call.
 * A single time-window control (This month / Last month / All time) rescopes
 * the whole panel — summary emphasis, provider strip, tables and drill-downs.
 *
 * Data honesty: every figure is an aggregate of actually-recorded calls.
 * Tracking starts when this feature shipped — earlier calls were never logged
 * and are NOT reconstructed or estimated. Anthropic costs = reported token
 * counts × published rates; DataForSEO costs come verbatim from its responses;
 * Semrush shows plan-dependent units (no $ guess); QStash shows message counts
 * (free tier bills $0; PAYG rate footnoted).
 */

import { useEffect, useState, useCallback, Fragment } from 'react';

type WindowKey = 'all' | 'month' | 'last';

interface Bucket { calls: number; costUsd: number; tokensIn: number; tokensOut: number; pricedCalls: number }
interface Windows { all: Bucket; month: Bucket; last: Bucket }
interface ProviderSplit { provider: string; windows: Windows }
interface ProjectSplit { projectId: string | null; name: string | null; deleted: boolean; windows: Windows }

interface UsageProject {
  projectId: string; name: string | null; deleted: boolean;
  windows: Windows; byProvider: ProviderSplit[];
  lastCallAt: string | null;
  budgetUsd: number | null; overBudget: boolean;
  costPerPage: number | null; pagesScored: number;
}
interface UsageProvider { provider: string; windows: Windows; byProject: ProjectSplit[] }
interface UsageRun {
  jobId: string; projectId: string | null; calls: number; costUsd: number;
  tokensIn: number; tokensOut: number; firstAt: string; lastAt: string;
  jobUrl: string | null; jobStatus: string | null; pagesScored: number | null;
}
interface UsageCall {
  id: string; createdAt: string; provider: string; purpose: string;
  model: string | null; inputTokens: number | null; outputTokens: number | null;
  costUsd: number | null; pageUrl: string | null; meta: Record<string, unknown>;
}
interface UsageData {
  pricingAsOf: string; trackingSince: string | null;
  projectMetaUnavailable?: boolean;
  summary: {
    allTime: { calls: number; costUsd: number; tokensIn: number; tokensOut: number };
    thisMonth: { calls: number; costUsd: number };
    lastMonth: { calls: number; costUsd: number };
    unpricedAnthropicCalls: number;
  };
  providers: UsageProvider[];
  projects: UsageProject[];
  runs: UsageRun[];
  unassigned: { windows: Windows; byProvider: ProviderSplit[] };
}

/* ── formatting ──────────────────────────────────────────────────────────── */
function usd(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n === 0) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}
function tok(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}
function ts(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
function shortUrl(u: string | null): string {
  if (!u) return '—';
  try {
    const p = new URL(u);
    const path = p.pathname.length > 34 ? p.pathname.slice(0, 34) + '…' : p.pathname;
    return p.hostname.replace(/^www\./, '') + path;
  } catch { return u.length > 44 ? u.slice(0, 44) + '…' : u; }
}
const PURPOSE_LABEL: Record<string, string> = {
  score: 'Score page', classify: 'Classify page', simulate: 'Simulate (workbench)',
  verify: 'Verify live (workbench)', rewrite: 'Rewrite (workbench)',
  generate: 'Generate copy (workbench)', research: 'Research (web search)',
  gap_brief: 'Competitor gap brief', serp_keywords: 'SERP keywords',
  serp_live: 'Live SERP scrape', serp_questions: 'SERP questions',
  coverage: 'Coverage check', llm_prompt: 'LLM prompt check',
  kw_volumes: 'Keyword volumes', prompt_gen: 'Prompt generation',
  brand_extract: 'Brand profile extract', scan_digest: 'Scheduled-scan email',
  scan_pause_notice: 'Scan paused email',
  queue_crawl_batch: 'Queue: crawl batch', queue_score_batch: 'Queue: score batch',
  queue_serp_batch: 'Queue: SERP batch', queue_classify_batch: 'Queue: classify batch',
  test: 'Diagnostics test',
};
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)', dataforseo: 'DataForSEO', semrush: 'Semrush',
  qstash: 'QStash (queue)', resend: 'Resend (email)',
};
const PROVIDER_SHORT: Record<string, string> = {
  anthropic: 'Anthropic', dataforseo: 'DataForSEO', semrush: 'Semrush',
  qstash: 'QStash', resend: 'Resend',
};
/** Providers whose bill this app cannot see — counts are shown, dollars are not asserted. */
const UNPRICED_PROVIDER: Record<string, string> = {
  qstash: 'count only¹', semrush: 'units-billed',
};
const label = (p: string) => PROVIDER_LABEL[p] ?? p;
const shortLabel = (p: string) => PROVIDER_SHORT[p] ?? p;

const WINDOW_LABEL: Record<WindowKey, string> = {
  month: 'This month', last: 'Last month', all: 'All time',
};

const th = 'px-4 py-3 border-b border-slate-200 font-medium text-left text-[10px] uppercase tracking-wider text-slate-400';
const td = 'px-4 py-2.5 border-b border-slate-100 align-top';

/** Cost cell that never asserts a dollar figure for a provider we can't price. */
function costText(provider: string | null, b: Bucket) {
  if (provider && UNPRICED_PROVIDER[provider]) {
    return <span className="text-slate-500">{UNPRICED_PROVIDER[provider]}</span>;
  }
  return <span className="tabular-nums">{usd(b.costUsd)}</span>;
}

/* ── call log (lazy, shared by every drill-down) ─────────────────────────── */
function CallLog({ query }: { query: string }) {
  const [calls, setCalls] = useState<UsageCall[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    setCalls(null);
    fetch(`/api/admin/usage/calls?${query}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (alive) setCalls(d.calls ?? []); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [query]);

  if (error) return <p className="text-[12px] text-red-600 px-4 py-3">Failed to load calls.</p>;
  if (!calls) return <p className="text-[12px] text-slate-400 px-4 py-3">Loading calls…</p>;
  if (calls.length === 0) return <p className="text-[12px] text-slate-400 px-4 py-3">No calls recorded in this view.</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead><tr>
          <th className={th}>Time</th><th className={th}>Call</th><th className={th}>Model</th>
          <th className={th}>Tokens in</th><th className={th}>Tokens out</th><th className={th}>Cost</th><th className={th}>Page</th>
        </tr></thead>
        <tbody>
          {calls.map(c => {
            const units = c.meta?.units_spent as number | undefined;
            const ws = c.meta?.web_search_requests as number | undefined;
            return (
              <tr key={c.id} className="hover:bg-slate-50">
                <td className={`${td} whitespace-nowrap text-slate-500`}>{ts(c.createdAt)}</td>
                <td className={td}>
                  <span className="font-medium text-slate-700">{PURPOSE_LABEL[c.purpose] ?? c.purpose}</span>
                  <span className="text-slate-400"> · {label(c.provider)}</span>
                  {ws ? <span className="text-slate-400"> · {ws} web search{ws === 1 ? '' : 'es'}</span> : null}
                </td>
                <td className={`${td} text-slate-500`}>{c.model ?? '—'}</td>
                <td className={`${td} text-right tabular-nums`}>{tok(c.inputTokens)}</td>
                <td className={`${td} text-right tabular-nums`}>{tok(c.outputTokens)}</td>
                <td className={`${td} text-right tabular-nums`}>
                  {c.costUsd != null ? usd(c.costUsd)
                    : units != null ? <span className="text-slate-500">{units} units</span>
                    : c.provider === 'qstash' ? <span className="text-slate-400">see note</span>
                    : <span className="text-amber-600" title="No published rate for this model at record time — not counted in totals">unpriced</span>}
                </td>
                <td className={`${td} text-slate-500`}>{shortUrl(c.pageUrl)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {calls.length >= 200 && (
        <p className="text-[11px] text-slate-400 px-4 py-2">Showing the most recent 200 calls.</p>
      )}
    </div>
  );
}

/* ── budget cell ─────────────────────────────────────────────────────────── */
function BudgetCell({ p, onSaved }: { p: UsageProject; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [val, setVal] = useState(p.budgetUsd != null ? String(p.budgetUsd) : '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    const res = await fetch('/api/admin/usage', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: p.projectId, monthlyBudgetUsd: val.trim() === '' ? null : Number(val) }),
    }).catch(() => null);
    setBusy(false);
    if (res?.ok) { setEditing(false); onSaved(); }
  }

  if (!editing) {
    return (
      <button
        className="text-[12px] text-slate-600 hover:text-indigo-600 underline decoration-dotted underline-offset-2"
        onClick={() => setEditing(true)}
        title="Set a monthly budget for the over-budget flag"
      >
        {p.budgetUsd != null ? `${usd(p.budgetUsd)}/mo` : 'Set budget'}
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5">
      <input
        value={val} onChange={e => setVal(e.target.value)} placeholder="e.g. 25"
        className="w-20 rounded border border-slate-300 px-2 py-1 text-[12px] outline-none focus:border-indigo-500"
        inputMode="decimal"
      />
      <button className="text-[12px] text-indigo-600 font-medium disabled:opacity-50" disabled={busy} onClick={save}>Save</button>
      <button className="text-[12px] text-slate-400" onClick={() => setEditing(false)}>Cancel</button>
    </span>
  );
}

/* ── per-API breakdown table (inside a project row) ──────────────────────── */
function ApiBreakdown({
  rows, win, callQueryFor,
}: {
  rows: ProviderSplit[];
  win: WindowKey;
  callQueryFor: (provider: string) => string;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const visible = rows.filter(r => r.windows[win].calls > 0);

  if (visible.length === 0) {
    return <p className="text-[12px] text-slate-400">No API calls in this window.</p>;
  }
  return (
    <table className="w-full text-[12px] bg-white rounded-lg border border-slate-200 mb-3">
      <thead><tr>
        <th className={th}>API</th><th className={th}>Calls</th>
        <th className={th}>Cost</th><th className={th}>Tokens (in / out)</th><th className={th}></th>
      </tr></thead>
      <tbody>
        {visible.map(r => {
          const b = r.windows[win];
          return (
            <Fragment key={r.provider}>
              <tr className="hover:bg-slate-50">
                <td className={`${td} font-medium text-slate-700`}>{label(r.provider)}</td>
                <td className={`${td} text-right tabular-nums`}>{b.calls.toLocaleString()}</td>
                <td className={`${td} text-right font-medium`}>{costText(r.provider, b)}</td>
                <td className={`${td} text-right tabular-nums text-slate-500`}>
                  {b.tokensIn || b.tokensOut ? `${tok(b.tokensIn)} / ${tok(b.tokensOut)}` : '—'}
                </td>
                <td className={`${td} text-right`}>
                  <button className="text-indigo-600 hover:underline"
                    onClick={() => setOpen(open === r.provider ? null : r.provider)}>
                    {open === r.provider ? 'Hide calls' : 'Calls ▸'}
                  </button>
                </td>
              </tr>
              {open === r.provider && (
                <tr><td colSpan={5} className="border-b border-slate-100 bg-slate-50">
                  <CallLog query={callQueryFor(r.provider)} />
                </td></tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ── main tab ────────────────────────────────────────────────────────────── */
export default function AdminUsageTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState(false);
  const [win, setWin] = useState<WindowKey>('all');
  const [groupBy, setGroupBy] = useState<'project' | 'api'>('project');
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [openProviderProject, setOpenProviderProject] = useState<string | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    const res = await fetch('/api/admin/usage', { cache: 'no-store' }).catch(() => null);
    if (!res || !res.ok) { setError(true); return; }
    setData(await res.json().catch(() => null));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (error) return <p className="text-sm text-red-600">Failed to load usage data.</p>;
  if (!data) return <p className="text-sm text-slate-400">Loading usage…</p>;

  const { summary } = data;
  const hasAny = summary.allTime.calls > 0;
  const qstash = data.providers.find(pr => pr.provider === 'qstash');
  const semrush = data.providers.find(pr => pr.provider === 'semrush');
  /** window suffix for every call-log query, so drill-downs match the totals */
  const winQ = win === 'all' ? '' : `&window=${win}`;

  const card = 'rounded-xl border border-slate-200 bg-white p-4 text-left transition';
  const cardActive = 'ring-2 ring-indigo-500 border-indigo-300';
  const seg = (on: boolean) =>
    `px-3 py-1.5 text-[12px] font-medium rounded-md transition ${
      on ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
    }`;

  /* cost-per-page for the selected window, from the same run rows the panel
     already shows (a run counts in the month it started). */
  function costPerPage(p: UsageProject): number | null {
    if (win === 'all') return p.costPerPage;
    const start = new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const from = new Date(start);
    if (win === 'last') from.setMonth(from.getMonth() - 1);
    const to = win === 'last' ? start : null;
    let cost = 0, pages = 0;
    for (const r of data!.runs) {
      if (r.projectId !== p.projectId) continue;
      const t = new Date(r.firstAt);
      if (t < from) continue;
      if (to && t >= to) continue;
      cost += r.costUsd; pages += r.pagesScored ?? 0;
    }
    return pages > 0 ? Math.round((cost / pages) * 10000) / 10000 : null;
  }

  function runsInWindow(projectId: string): UsageRun[] {
    const all = data!.runs.filter(r => r.projectId === projectId);
    if (win === 'all') return all;
    const start = new Date();
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const from = new Date(start);
    if (win === 'last') from.setMonth(from.getMonth() - 1);
    const to = win === 'last' ? start : null;
    return all.filter(r => {
      const t = new Date(r.firstAt);
      return t >= from && (!to || t < to);
    });
  }

  const projectRows = data.projects.filter(p => p.windows[win].calls > 0);
  const providerRows = data.providers.filter(pr => pr.windows[win].calls > 0);
  const unassignedB = data.unassigned.windows[win];

  return (
    <div>
      {/* summary cards — also the time-window selector */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-4">
        <button className={`${card} ${win === 'month' ? cardActive : 'hover:border-slate-300'}`}
          onClick={() => setWin('month')} aria-pressed={win === 'month'}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">This month</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.thisMonth.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">{summary.thisMonth.calls.toLocaleString()} API calls</p>
        </button>
        <button className={`${card} ${win === 'last' ? cardActive : 'hover:border-slate-300'}`}
          onClick={() => setWin('last')} aria-pressed={win === 'last'}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">Last month</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.lastMonth.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">{summary.lastMonth.calls.toLocaleString()} API calls</p>
        </button>
        <button className={`${card} ${win === 'all' ? cardActive : 'hover:border-slate-300'}`}
          onClick={() => setWin('all')} aria-pressed={win === 'all'}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">All time (since tracking began)</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.allTime.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {summary.allTime.calls.toLocaleString()} calls · {tok(summary.allTime.tokensIn)} in / {tok(summary.allTime.tokensOut)} out
          </p>
        </button>
      </div>

      {/* project-name lookup failure — never silently mislabel projects again */}
      {data.projectMetaUnavailable && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 mb-4 text-[12px] text-amber-800">
          Project names and budgets couldn&apos;t be read from the database, so every row below is
          labelled as a deleted project. The spend figures are still accurate — see the server log
          for the underlying error.
        </div>
      )}

      {/* provider strip — scoped to the selected window, click to inspect */}
      {hasAny && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {providerRows.map(pr => {
            const b = pr.windows[win];
            const active = groupBy === 'api' && openProvider === pr.provider;
            return (
              <button key={pr.provider}
                onClick={() => { setGroupBy('api'); setOpenProvider(active ? null : pr.provider); setOpenProviderProject(null); }}
                title={`Break ${label(pr.provider)} down by project`}
                className={`inline-flex items-center gap-2 rounded-lg border bg-white px-3 py-1.5 text-[12px] transition ${
                  active ? 'border-indigo-400 ring-1 ring-indigo-200' : 'border-slate-200 hover:border-slate-300'
                }`}>
                <span className="font-medium text-slate-700">{label(pr.provider)}</span>
                <span className="text-slate-400">{b.calls.toLocaleString()} calls</span>
                <span className="text-slate-900 font-semibold">{costText(pr.provider, b)}</span>
              </button>
            );
          })}
          <button onClick={load} className="text-[12px] text-indigo-600 hover:underline px-2">Refresh</button>
        </div>
      )}

      {/* group-by control */}
      {hasAny && (
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div className="inline-flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">Group by</span>
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5">
              <button className={seg(groupBy === 'project')} onClick={() => setGroupBy('project')}>Project</button>
              <button className={seg(groupBy === 'api')} onClick={() => setGroupBy('api')}>API</button>
            </div>
          </div>
          <p className="text-[12px] text-slate-500">
            Showing <span className="font-medium text-slate-700">{WINDOW_LABEL[win]}</span>
            {win !== 'all' && <span className="text-slate-400"> — click a card above to change</span>}
          </p>
        </div>
      )}

      {/* empty state — honest about no backfill */}
      {!hasAny && (
        <div className="rounded-xl border border-slate-200 bg-white text-center py-14 px-6 text-sm text-slate-500">
          <p className="font-medium text-slate-700">No API calls recorded yet.</p>
          <p className="mt-1 max-w-xl mx-auto">
            Tracking starts with this release. Calls made before it were never logged, so they can&apos;t be
            shown or reconstructed — the ledger fills in as new audits, workbench actions, and SERP fetches run.
          </p>
        </div>
      )}

      {/* ── GROUP BY PROJECT ───────────────────────────────────────────── */}
      {hasAny && groupBy === 'project' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden mb-4">
          <table className="w-full text-[13px]">
            <thead><tr>
              <th className={th}>Project</th>
              <th className={th}>Calls</th>
              <th className={th}>Cost</th>
              <th className={th}>Tokens (in / out)</th>
              <th className={th}>Cost / page²</th>
              <th className={th}>Budget</th>
              <th className={th}></th>
            </tr></thead>
            <tbody>
              {projectRows.length === 0 && (
                <tr><td className={`${td} text-slate-400`} colSpan={7}>
                  No API calls recorded for any project in {WINDOW_LABEL[win].toLowerCase()}.
                </td></tr>
              )}
              {projectRows.map(p => {
                const b = p.windows[win];
                const runs = runsInWindow(p.projectId);
                const open = openProject === p.projectId;
                const split = p.byProvider.filter(s => s.windows[win].calls > 0);
                const cpp = costPerPage(p);
                return (
                  <Fragment key={p.projectId}>
                    <tr className={`hover:bg-slate-50 ${p.overBudget ? 'bg-amber-50/60' : ''}`}>
                      <td className={`${td} font-semibold`}>
                        {p.name ?? <span className="text-slate-400 font-normal italic">Deleted project</span>}
                        {p.overBudget && (
                          <span className="ml-2 text-[10px] font-medium px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">Over budget</span>
                        )}
                        {/* per-API split, readable without expanding */}
                        {split.length > 0 && (
                          <p className="mt-1 text-[11px] font-normal text-slate-400">
                            {split.map((s, i) => (
                              <span key={s.provider}>
                                {i > 0 && <span className="text-slate-300"> · </span>}
                                {shortLabel(s.provider)}{' '}
                                <span className="text-slate-500 tabular-nums">
                                  {UNPRICED_PROVIDER[s.provider]
                                    ? `${s.windows[win].calls.toLocaleString()} calls`
                                    : usd(s.windows[win].costUsd)}
                                </span>
                              </span>
                            ))}
                          </p>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{b.calls.toLocaleString()}</td>
                      <td className={`${td} tabular-nums font-medium`}>{usd(b.costUsd)}</td>
                      <td className={`${td} tabular-nums text-slate-500`}>{tok(b.tokensIn)} / {tok(b.tokensOut)}</td>
                      <td className={`${td} tabular-nums`}>{cpp != null ? usd(cpp) : '—'}</td>
                      <td className={td}>{p.deleted ? '—' : <BudgetCell p={p} onSaved={load} />}</td>
                      <td className={`${td} text-right`}>
                        <button
                          className="text-[12px] text-indigo-600 hover:underline"
                          onClick={() => { setOpenProject(open ? null : p.projectId); setOpenRun(null); }}
                        >
                          {open ? 'Hide detail' : 'Detail ▸'}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr><td colSpan={7} className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
                        <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium mb-1.5">By API</p>
                        <ApiBreakdown
                          rows={p.byProvider} win={win}
                          callQueryFor={prov => `projectId=${p.projectId}&provider=${prov}${winQ}`}
                        />
                        <p className="text-[10px] uppercase tracking-wider text-slate-400 font-medium mb-1.5">Audit runs</p>
                        {runs.length === 0 ? (
                          <p className="text-[12px] text-slate-400">No audit-run calls in this window (non-run calls like gap briefs still count in the totals above).</p>
                        ) : (
                          <table className="w-full text-[12px] bg-white rounded-lg border border-slate-200">
                            <thead><tr>
                              <th className={th}>Run started</th><th className={th}>Audit URL</th><th className={th}>Status</th>
                              <th className={th}>Pages scored</th><th className={th}>Calls</th>
                              <th className={th}>Tokens (in / out)</th><th className={th}>Cost</th><th className={th}>Cost / page</th><th className={th}></th>
                            </tr></thead>
                            <tbody>
                              {runs.map(r => (
                                <Fragment key={r.jobId}>
                                  <tr className="hover:bg-slate-50">
                                    <td className={`${td} whitespace-nowrap text-slate-500`}>{ts(r.firstAt)}</td>
                                    <td className={td}>{shortUrl(r.jobUrl)}</td>
                                    <td className={`${td} text-slate-500`}>{r.jobStatus ?? '—'}</td>
                                    <td className={`${td} text-right tabular-nums`}>{r.pagesScored ?? '—'}</td>
                                    <td className={`${td} text-right tabular-nums`}>{r.calls}</td>
                                    <td className={`${td} text-right tabular-nums text-slate-500`}>{tok(r.tokensIn)} / {tok(r.tokensOut)}</td>
                                    <td className={`${td} text-right tabular-nums font-medium`}>{usd(r.costUsd)}</td>
                                    <td className={`${td} text-right tabular-nums`}>
                                      {r.pagesScored ? usd(r.costUsd / r.pagesScored) : '—'}
                                    </td>
                                    <td className={`${td} text-right`}>
                                      <button className="text-indigo-600 hover:underline"
                                        onClick={() => setOpenRun(openRun === r.jobId ? null : r.jobId)}>
                                        {openRun === r.jobId ? 'Hide calls' : 'Calls ▸'}
                                      </button>
                                    </td>
                                  </tr>
                                  {openRun === r.jobId && (
                                    <tr><td colSpan={9} className="border-b border-slate-100 bg-slate-50">
                                      <CallLog query={`jobId=${r.jobId}`} />
                                    </td></tr>
                                  )}
                                </Fragment>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}

              {/* unassigned bucket */}
              {unassignedB.calls > 0 && (
                <Fragment>
                  <tr className="hover:bg-slate-50">
                    <td className={`${td} text-slate-500 italic`}>
                      Unassigned (diagnostics / deleted runs)
                      {data.unassigned.byProvider.filter(s => s.windows[win].calls > 0).length > 0 && (
                        <p className="mt-1 text-[11px] not-italic text-slate-400">
                          {data.unassigned.byProvider.filter(s => s.windows[win].calls > 0).map((s, i) => (
                            <span key={s.provider}>
                              {i > 0 && <span className="text-slate-300"> · </span>}
                              {shortLabel(s.provider)}{' '}
                              <span className="text-slate-500 tabular-nums">
                                {UNPRICED_PROVIDER[s.provider]
                                  ? `${s.windows[win].calls.toLocaleString()} calls`
                                  : usd(s.windows[win].costUsd)}
                              </span>
                            </span>
                          ))}
                        </p>
                      )}
                    </td>
                    <td className={`${td} tabular-nums`}>{unassignedB.calls.toLocaleString()}</td>
                    <td className={`${td} tabular-nums font-medium`}>{usd(unassignedB.costUsd)}</td>
                    <td className={`${td} tabular-nums text-slate-500`}>{tok(unassignedB.tokensIn)} / {tok(unassignedB.tokensOut)}</td>
                    <td className={td}></td><td className={td}></td>
                    <td className={`${td} text-right`}>
                      <button className="text-[12px] text-indigo-600 hover:underline" onClick={() => setShowUnassigned(v => !v)}>
                        {showUnassigned ? 'Hide calls' : 'Calls ▸'}
                      </button>
                    </td>
                  </tr>
                  {showUnassigned && (
                    <tr><td colSpan={7} className="border-b border-slate-100 bg-slate-50">
                      <CallLog query={`scope=unassigned${winQ}`} />
                    </td></tr>
                  )}
                </Fragment>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* ── GROUP BY API ───────────────────────────────────────────────── */}
      {hasAny && groupBy === 'api' && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden mb-4">
          <table className="w-full text-[13px]">
            <thead><tr>
              <th className={th}>API</th>
              <th className={th}>Calls</th>
              <th className={th}>Cost</th>
              <th className={th}>Tokens (in / out)</th>
              <th className={th}>Share of spend</th>
              <th className={th}></th>
            </tr></thead>
            <tbody>
              {providerRows.length === 0 && (
                <tr><td className={`${td} text-slate-400`} colSpan={6}>
                  No API calls recorded in {WINDOW_LABEL[win].toLowerCase()}.
                </td></tr>
              )}
              {providerRows.map(pr => {
                const b = pr.windows[win];
                const open = openProvider === pr.provider;
                const totalCost = providerRows.reduce((n, x) => n + x.windows[win].costUsd, 0);
                const share = totalCost > 0 ? (b.costUsd / totalCost) * 100 : 0;
                const split = pr.byProject.filter(s => s.windows[win].calls > 0);
                return (
                  <Fragment key={pr.provider}>
                    <tr className="hover:bg-slate-50">
                      <td className={`${td} font-semibold`}>{label(pr.provider)}</td>
                      <td className={`${td} tabular-nums`}>{b.calls.toLocaleString()}</td>
                      <td className={`${td} font-medium`}>{costText(pr.provider, b)}</td>
                      <td className={`${td} tabular-nums text-slate-500`}>
                        {b.tokensIn || b.tokensOut ? `${tok(b.tokensIn)} / ${tok(b.tokensOut)}` : '—'}
                      </td>
                      <td className={td}>
                        {UNPRICED_PROVIDER[pr.provider] ? <span className="text-slate-400">—</span> : (
                          <span className="inline-flex items-center gap-2">
                            <span className="h-1.5 w-20 rounded-full bg-slate-100 overflow-hidden">
                              <span className="block h-full bg-indigo-500" style={{ width: `${Math.round(share)}%` }} />
                            </span>
                            <span className="tabular-nums text-slate-500 text-[12px]">{share.toFixed(0)}%</span>
                          </span>
                        )}
                      </td>
                      <td className={`${td} text-right`}>
                        <button className="text-[12px] text-indigo-600 hover:underline"
                          onClick={() => { setOpenProvider(open ? null : pr.provider); setOpenProviderProject(null); }}>
                          {open ? 'Hide projects' : `${split.length} project${split.length === 1 ? '' : 's'} ▸`}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr><td colSpan={6} className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
                        {split.length === 0 ? (
                          <p className="text-[12px] text-slate-400">No calls in this window.</p>
                        ) : (
                          <table className="w-full text-[12px] bg-white rounded-lg border border-slate-200">
                            <thead><tr>
                              <th className={th}>Project</th><th className={th}>Calls</th>
                              <th className={th}>Cost</th><th className={th}>Tokens (in / out)</th><th className={th}></th>
                            </tr></thead>
                            <tbody>
                              {split.map(sp => {
                                const sb = sp.windows[win];
                                const key = `${pr.provider}:${sp.projectId ?? 'unassigned'}`;
                                const q = sp.projectId
                                  ? `projectId=${sp.projectId}&provider=${pr.provider}${winQ}`
                                  : `scope=unassigned&provider=${pr.provider}${winQ}`;
                                return (
                                  <Fragment key={key}>
                                    <tr className="hover:bg-slate-50">
                                      <td className={`${td} font-medium text-slate-700`}>
                                        {sp.projectId == null
                                          ? <span className="text-slate-500 italic font-normal">Unassigned (diagnostics / deleted runs)</span>
                                          : sp.name ?? <span className="text-slate-400 italic font-normal">Deleted project</span>}
                                      </td>
                                      <td className={`${td} text-right tabular-nums`}>{sb.calls.toLocaleString()}</td>
                                      <td className={`${td} text-right font-medium`}>{costText(pr.provider, sb)}</td>
                                      <td className={`${td} text-right tabular-nums text-slate-500`}>
                                        {sb.tokensIn || sb.tokensOut ? `${tok(sb.tokensIn)} / ${tok(sb.tokensOut)}` : '—'}
                                      </td>
                                      <td className={`${td} text-right`}>
                                        <button className="text-indigo-600 hover:underline"
                                          onClick={() => setOpenProviderProject(openProviderProject === key ? null : key)}>
                                          {openProviderProject === key ? 'Hide calls' : 'Calls ▸'}
                                        </button>
                                      </td>
                                    </tr>
                                    {openProviderProject === key && (
                                      <tr><td colSpan={5} className="border-b border-slate-100 bg-slate-50">
                                        <CallLog query={q} />
                                      </td></tr>
                                    )}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                          </table>
                        )}
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* honesty footnotes */}
      <div className="text-[11px] text-slate-400 leading-relaxed space-y-1">
        <p>
          Tracking since {data.trackingSince ? new Date(data.trackingSince).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'this release'} —
          earlier API calls were not logged and are not estimated. Anthropic costs are computed from each call&apos;s reported
          token counts × Anthropic&apos;s published rates (as of {data.pricingAsOf}); web searches bill $10 per 1,000.
          DataForSEO costs are the exact charged amounts returned by its API.
          {summary.unpricedAnthropicCalls > 0 && (
            <span className="text-amber-600"> {summary.unpricedAnthropicCalls} call(s) had no published rate at record time and are excluded from totals.</span>
          )}
        </p>
        <p>² Cost / page = spend on that project&apos;s audit runs ÷ pages those runs actually scored, for the selected window (a run counts in the month it started).</p>
        {qstash && (
          <p>¹ QStash: {qstash.windows[win].calls.toLocaleString()} queue messages in {WINDOW_LABEL[win].toLowerCase()}. Free tier (1,000/day) bills $0; pay-as-you-go is $1 per 100K messages
            (≈{usd(qstash.windows[win].calls * 0.00001)} if on PAYG). Message counts are shown instead of asserting a bill we can&apos;t see — so QStash adds nothing to the project cost columns.</p>
        )}
        {semrush && (
          <p>Semrush bills in plan-dependent API units — unit counts are recorded per call (see call log); no dollar figure is assumed.</p>
        )}
      </div>
    </div>
  );
}
