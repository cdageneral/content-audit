'use client';

/**
 * AdminUsageTab — super_admin "API Usage" tab on /admin.
 *
 * Shows the real recorded API-call ledger: monthly cost summary, per-provider
 * breakdown, per-project rollups with budgets and cost-per-page, drillable to
 * each audit run and each individual call (timestamp, purpose, model, exact
 * token counts, exact cost).
 *
 * Data honesty: every figure is an aggregate of actually-recorded calls.
 * Tracking starts when this feature shipped — earlier calls were never logged
 * and are NOT reconstructed or estimated. Anthropic costs = reported token
 * counts × published rates; DataForSEO costs come verbatim from its responses;
 * Semrush shows plan-dependent units (no $ guess); QStash shows message counts
 * (free tier bills $0; PAYG rate footnoted).
 */

import { useEffect, useState, useCallback, Fragment } from 'react';

interface Bucket { calls: number; costUsd: number; tokensIn?: number; tokensOut?: number }
interface UsageProject {
  projectId: string; name: string | null; deleted: boolean;
  calls: number; costUsd: number; tokensIn: number; tokensOut: number;
  thisMonthCost: number; lastMonthCost: number; lastCallAt: string;
  budgetUsd: number | null; overBudget: boolean;
  costPerPage: number | null; pagesScored: number;
}
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
  summary: {
    allTime: Bucket; thisMonth: Bucket; lastMonth: Bucket;
    unpricedAnthropicCalls: number;
  };
  providers: { provider: string; calls: number; costUsd: number; pricedCalls: number; tokensIn: number; tokensOut: number }[];
  projects: UsageProject[];
  runs: UsageRun[];
  unassigned: Bucket;
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
  queue_crawl_batch: 'Queue: crawl batch', queue_score_batch: 'Queue: score batch',
  queue_serp_batch: 'Queue: SERP batch', queue_classify_batch: 'Queue: classify batch',
  test: 'Diagnostics test',
};
const PROVIDER_LABEL: Record<string, string> = {
  anthropic: 'Anthropic (Claude)', dataforseo: 'DataForSEO', semrush: 'Semrush', qstash: 'QStash (queue)',
};

const th = 'px-4 py-3 border-b border-slate-200 font-medium text-left text-[10px] uppercase tracking-wider text-slate-400';
const td = 'px-4 py-2.5 border-b border-slate-100 align-top';

/* ── call log (lazy, shared by run + unassigned drill-downs) ─────────────── */
function CallLog({ query }: { query: string }) {
  const [calls, setCalls] = useState<UsageCall[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/admin/usage/calls?${query}`, { cache: 'no-store' })
      .then(r => r.json())
      .then(d => { if (alive) setCalls(d.calls ?? []); })
      .catch(() => { if (alive) setError(true); });
    return () => { alive = false; };
  }, [query]);

  if (error) return <p className="text-[12px] text-red-600 px-4 py-3">Failed to load calls.</p>;
  if (!calls) return <p className="text-[12px] text-slate-400 px-4 py-3">Loading calls…</p>;
  if (calls.length === 0) return <p className="text-[12px] text-slate-400 px-4 py-3">No calls recorded.</p>;

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
                  <span className="text-slate-400"> · {PROVIDER_LABEL[c.provider] ?? c.provider}</span>
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

/* ── main tab ────────────────────────────────────────────────────────────── */
export default function AdminUsageTab() {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState(false);
  const [openProject, setOpenProject] = useState<string | null>(null);
  const [openRun, setOpenRun] = useState<string | null>(null);
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

  const card = 'rounded-xl border border-slate-200 bg-white p-4';

  return (
    <div>
      {/* summary cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5">
        <div className={card}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">This month</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.thisMonth.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">{summary.thisMonth.calls.toLocaleString()} API calls</p>
        </div>
        <div className={card}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">Last month</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.lastMonth.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">{summary.lastMonth.calls.toLocaleString()} API calls</p>
        </div>
        <div className={card}>
          <p className="text-[11px] uppercase tracking-wider text-slate-400 font-medium">All time (since tracking began)</p>
          <p className="text-2xl font-semibold mt-1 tabular-nums">{usd(summary.allTime.costUsd)}</p>
          <p className="text-[12px] text-slate-500 mt-0.5">
            {summary.allTime.calls.toLocaleString()} calls · {tok(summary.allTime.tokensIn)} in / {tok(summary.allTime.tokensOut)} out
          </p>
        </div>
      </div>

      {/* provider strip */}
      {hasAny && (
        <div className="flex flex-wrap gap-2 mb-5">
          {data.providers.map(pr => (
            <span key={pr.provider} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px]">
              <span className="font-medium text-slate-700">{PROVIDER_LABEL[pr.provider] ?? pr.provider}</span>
              <span className="text-slate-400">{pr.calls.toLocaleString()} calls</span>
              {pr.provider === 'semrush' ? (
                <span className="text-slate-500">units-billed</span>
              ) : pr.provider === 'qstash' ? (
                <span className="text-slate-500">count only¹</span>
              ) : (
                <span className="text-slate-900 font-semibold tabular-nums">{usd(pr.costUsd)}</span>
              )}
            </span>
          ))}
          <button onClick={load} className="text-[12px] text-indigo-600 hover:underline px-2">Refresh</button>
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

      {/* projects table */}
      {hasAny && (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden mb-4">
          <table className="w-full text-[13px]">
            <thead><tr>
              <th className={th}>Project</th>
              <th className={th}>This month</th>
              <th className={th}>Last month</th>
              <th className={th}>All time</th>
              <th className={th}>Tokens (in / out)</th>
              <th className={th}>Cost / page²</th>
              <th className={th}>Budget</th>
              <th className={th}></th>
            </tr></thead>
            <tbody>
              {data.projects.map(p => {
                const runs = data.runs.filter(r => r.projectId === p.projectId);
                const open = openProject === p.projectId;
                return (
                  <Fragment key={p.projectId}>
                    <tr className={`hover:bg-slate-50 ${p.overBudget ? 'bg-amber-50/60' : ''}`}>
                      <td className={`${td} font-semibold`}>
                        {p.name ?? <span className="text-slate-400 font-normal italic">Deleted project</span>}
                        {p.overBudget && (
                          <span className="ml-2 text-[10px] font-medium px-2 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-200">Over budget</span>
                        )}
                      </td>
                      <td className={`${td} tabular-nums`}>{usd(p.thisMonthCost)}</td>
                      <td className={`${td} tabular-nums text-slate-500`}>{usd(p.lastMonthCost)}</td>
                      <td className={`${td} tabular-nums font-medium`}>{usd(p.costUsd)}</td>
                      <td className={`${td} tabular-nums text-slate-500`}>{tok(p.tokensIn)} / {tok(p.tokensOut)}</td>
                      <td className={`${td} tabular-nums`}>{p.costPerPage != null ? usd(p.costPerPage) : '—'}</td>
                      <td className={td}>{p.deleted ? '—' : <BudgetCell p={p} onSaved={load} />}</td>
                      <td className={`${td} text-right`}>
                        <button
                          className="text-[12px] text-indigo-600 hover:underline"
                          onClick={() => { setOpenProject(open ? null : p.projectId); setOpenRun(null); }}
                        >
                          {open ? 'Hide runs' : `${runs.length} run${runs.length === 1 ? '' : 's'} ▸`}
                        </button>
                      </td>
                    </tr>
                    {open && (
                      <tr><td colSpan={8} className="border-b border-slate-100 bg-slate-50/60 px-4 py-3">
                        {runs.length === 0 ? (
                          <p className="text-[12px] text-slate-400">No audit-run calls recorded for this project yet (non-run calls like gap briefs still count in the totals above).</p>
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
              {data.unassigned.calls > 0 && (
                <Fragment>
                  <tr className="hover:bg-slate-50">
                    <td className={`${td} text-slate-500 italic`}>Unassigned (diagnostics / deleted runs)</td>
                    <td className={td}></td><td className={td}></td>
                    <td className={`${td} tabular-nums font-medium`}>{usd(data.unassigned.costUsd)}</td>
                    <td className={`${td} tabular-nums text-slate-500`}>{tok(data.unassigned.tokensIn)} / {tok(data.unassigned.tokensOut)}</td>
                    <td className={td}></td><td className={td}></td>
                    <td className={`${td} text-right`}>
                      <button className="text-[12px] text-indigo-600 hover:underline" onClick={() => setShowUnassigned(v => !v)}>
                        {showUnassigned ? 'Hide calls' : `${data.unassigned.calls} calls ▸`}
                      </button>
                    </td>
                  </tr>
                  {showUnassigned && (
                    <tr><td colSpan={8} className="border-b border-slate-100 bg-slate-50">
                      <CallLog query="scope=unassigned" />
                    </td></tr>
                  )}
                </Fragment>
              )}
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
        {qstash && (
          <p>¹ QStash: {qstash.calls.toLocaleString()} queue messages. Free tier (1,000/day) bills $0; pay-as-you-go is $1 per 100K messages
            (≈{usd(qstash.calls * 0.00001)} if on PAYG). Message counts are shown instead of asserting a bill we can&apos;t see.</p>
        )}
        {semrush && (
          <p>Semrush bills in plan-dependent API units — unit counts are recorded per call (see call log); no dollar figure is assumed.</p>
        )}
      </div>
    </div>
  );
}
