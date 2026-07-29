'use client';

// ─────────────────────────────────────────────────────────────
//  ScanScheduleView — the Scan Schedule (Setup) page body.
//  Cadence presets (weekly / 1st & 15th / monthly) + day picker,
//  email notification settings, and the honest scheduled-run
//  history (completed / skipped-with-reason / failed / paused).
//
//  Editing model: everything edits local state; one Save button
//  PUTs the whole schedule. The SERVER owns derived state — it
//  recomputes next_run_at and clears the auto-pause on re-enable —
//  so the response replaces local state after every save.
//
//  ⚠️ Imports from lib/schedule are types + pure cadence math only
//  (lib/schedule/types) — never the store or anything Neon.
// ─────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import {
  CADENCE_LABELS,
  DOW_LABELS,
  emptyScanSchedule,
  nextRunPreview,
  MANUAL_SKIP_HOURS,
  AUTO_PAUSE_AFTER,
  type ScanCadence,
  type ScanRun,
  type ScanSchedule,
} from '@/lib/schedule/types';

interface Props {
  projectId: string;
  projectName: string;
  initialSchedule: ScanSchedule | null;
  initialRuns: ScanRun[];
  /** TRUE when RESEND_API_KEY is configured server-side. */
  emailReady: boolean;
}

const fmtDay = (d: Date): string =>
  d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

const fmtDate = (iso: string): string =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

export default function ScanScheduleView({
  projectId,
  projectName,
  initialSchedule,
  initialRuns,
  emailReady,
}: Props) {
  const [schedule, setSchedule] = useState<ScanSchedule>(
    initialSchedule ?? emptyScanSchedule(projectId)
  );
  const [runs] = useState<ScanRun[]>(initialRuns);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);
  const [recipientInput, setRecipientInput] = useState('');
  // Next-run preview uses "now" — render it only after mount so the SSR and
  // client HTML can't disagree (hydration guard).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const paused = !schedule.enabled && Boolean(schedule.pausedReason);

  const edit = (fn: (draft: ScanSchedule) => void) => {
    setSchedule((prev) => {
      const draft = { ...prev, recipients: [...prev.recipients] };
      fn(draft);
      return draft;
    });
    setDirty(true);
    setSavedFlash(false);
  };

  async function save(override?: Partial<ScanSchedule>) {
    setSaving(true);
    setError('');
    try {
      const payload = { ...schedule, ...override };
      const res = await fetch(`/api/projects/${projectId}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ schedule: payload }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.schedule) {
        setError(data.error ?? 'Failed to save schedule');
        return;
      }
      setSchedule(data.schedule);
      setDirty(false);
      setSavedFlash(true);
    } catch {
      setError('Network error — please try again');
    } finally {
      setSaving(false);
    }
  }

  function addRecipient() {
    const email = recipientInput.trim().toLowerCase();
    if (!email) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError(`"${email}" doesn't look like an email address`);
      return;
    }
    setError('');
    if (!schedule.recipients.includes(email)) {
      edit((d) => {
        d.recipients = [...d.recipients, email].slice(0, 10);
      });
    }
    setRecipientInput('');
  }

  const preview = mounted
    ? nextRunPreview(schedule.cadence, schedule.dayOfWeek, schedule.dayOfMonth, 3)
    : [];

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      {/* ── Page head ── */}
      <div className="anim-fade-up relative z-30 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight" style={{ color: 'var(--text-1)' }}>
            Scan Schedule
          </h1>
          <p className="text-sm mt-1 max-w-2xl leading-relaxed" style={{ color: 'var(--text-3)' }}>
            Pick a cadence and {projectName} re-scans automatically — every page re-crawled,
            anything that changed re-scored, and an email with what moved. Scans run overnight
            (Pacific) so results are ready in the morning.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <label className="flex items-center gap-2 text-[13px] font-semibold" style={{ color: 'var(--text-2)' }}>
            Schedule
            <button
              role="switch"
              aria-checked={schedule.enabled}
              aria-label="Enable scheduled scans"
              onClick={() => edit((d) => { d.enabled = !d.enabled; d.pausedReason = null; })}
              className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
              style={{ background: schedule.enabled ? '#4f46e5' : 'var(--bg-3)' }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
                style={{ left: schedule.enabled ? '18px' : '2px' }}
              />
            </button>
          </label>
          <button
            className="btn-primary"
            onClick={() => save()}
            disabled={saving || !dirty}
          >
            {saving ? 'Saving…' : savedFlash && !dirty ? 'Saved ✓' : 'Save schedule'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700">
          {error}
        </div>
      )}

      {/* ── Status line ── */}
      {paused ? (
        <div className="anim-fade-up rounded-[10px] border px-4 py-2.5 text-[13px] flex items-start gap-2 flex-wrap"
          style={{ background: '#fffbeb', borderColor: '#fcd34d', color: '#92400e' }}>
          <span className="mt-[5px] w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#d97706' }} />
          <span>
            <b>Schedule paused automatically</b> — {AUTO_PAUSE_AFTER} scheduled scans in a row
            couldn&apos;t complete. Last error: {schedule.pausedReason}. Your existing scores are
            untouched.
            <button
              className="ml-2 font-semibold underline"
              onClick={() => save({ enabled: true, pausedReason: null })}
              disabled={saving}
            >
              Resume schedule
            </button>
          </span>
        </div>
      ) : schedule.enabled ? (
        <div className="anim-fade-up rounded-[10px] border px-4 py-2.5 text-[13px] flex items-center gap-2 flex-wrap"
          style={{ background: '#ecfdf5', borderColor: '#a7f3d0', color: '#065f46' }}>
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#059669' }} />
          {dirty ? (
            <span>Schedule on — save to apply your changes.</span>
          ) : (
            <span>
              Schedule active
              {schedule.nextRunAt ? <> — next scan <b>{fmtDate(schedule.nextRunAt)}</b> (overnight)</> : null}
              {schedule.lastRunAt ? (
                <span style={{ color: '#047857', fontWeight: 400 }}>
                  {' '}· last scheduled activity {fmtDate(schedule.lastRunAt)}
                </span>
              ) : null}
            </span>
          )}
        </div>
      ) : (
        <div className="anim-fade-up rounded-[10px] border px-4 py-2.5 text-[13px] flex items-center gap-2"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--text-2)' }}>
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: 'var(--text-3)' }} />
          Scheduled scans are off — set a cadence below and flip the switch to turn them on.
        </div>
      )}

      {/* ── Cadence ── */}
      <div className="anim-fade-up stagger-1 card p-5">
        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-1)' }}>Cadence</p>
        <div className="grid gap-3 sm:grid-cols-3">
          {(Object.keys(CADENCE_LABELS) as ScanCadence[]).map((c) => {
            const sel = schedule.cadence === c;
            const desc =
              c === 'weekly'
                ? 'Every week on a day you pick. Best for sites publishing often.'
                : c === 'twice_monthly'
                  ? 'The 1st and the 15th. A good default for most client sites.'
                  : 'Once a month on a day you pick. Lines up with the monthly SERP data refresh.';
            return (
              <button
                key={c}
                onClick={() => edit((d) => { d.cadence = c; })}
                className="relative text-left rounded-xl border px-4 py-3.5 transition-colors"
                style={sel
                  ? { borderColor: '#4f46e5', background: 'rgba(99,102,241,0.07)' }
                  : { borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                <span
                  className="absolute top-3.5 right-3.5 w-4 h-4 rounded-full border-2"
                  style={sel ? { borderColor: '#4f46e5', borderWidth: 5 } : { borderColor: 'var(--border-hi, #d1d5db)' }}
                />
                <span className="block text-[14px] font-bold" style={{ color: sel ? '#4f46e5' : 'var(--text-1)' }}>
                  {CADENCE_LABELS[c]}
                </span>
                <span className="block text-[12px] mt-1 leading-snug pr-5" style={{ color: 'var(--text-3)' }}>
                  {desc}
                </span>
              </button>
            );
          })}
        </div>

        {/* Day picker */}
        {schedule.cadence === 'weekly' && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-[0.04em] mr-1" style={{ color: 'var(--text-3)' }}>
              Run on
            </span>
            {DOW_LABELS.map((label, i) => (
              <button
                key={label}
                onClick={() => edit((d) => { d.dayOfWeek = i; })}
                className="w-10 h-8 rounded-lg border text-[12.5px] font-semibold transition-colors"
                style={schedule.dayOfWeek === i
                  ? { background: '#4f46e5', borderColor: '#4f46e5', color: '#fff' }
                  : { background: 'var(--bg-1)', borderColor: 'var(--border)', color: 'var(--text-2)' }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {schedule.cadence === 'monthly' && (
          <div className="mt-4 flex items-center gap-2 flex-wrap">
            <span className="text-[11px] font-bold uppercase tracking-[0.04em] mr-1" style={{ color: 'var(--text-3)' }}>
              Run on day
            </span>
            <select
              value={schedule.dayOfMonth}
              onChange={(e) => edit((d) => { d.dayOfMonth = parseInt(e.target.value, 10); })}
              className="rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ background: 'var(--bg-1)', borderColor: 'var(--border)', color: 'var(--text-1)' }}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
            <span className="text-[12px]" style={{ color: 'var(--text-3)' }}>
              (1–28, so it exists in every month)
            </span>
          </div>
        )}
        {schedule.cadence === 'twice_monthly' && (
          <p className="mt-4 text-[12.5px]" style={{ color: 'var(--text-3)' }}>
            Runs on the <b>1st</b> and the <b>15th</b> of each month.
          </p>
        )}

        {mounted && preview.length > 0 && (
          <div className="mt-4 rounded-[10px] border px-4 py-2.5 text-[13px]"
            style={{ background: 'rgba(111,28,254,0.05)', borderColor: 'rgba(111,28,254,0.18)', color: 'var(--text-2)' }}>
            Next three runs:{' '}
            <b style={{ color: '#6f1cfe' }}>{preview.map(fmtDay).join(' · ')}</b>
            {dirty && <span style={{ color: 'var(--text-3)' }}> (after you save)</span>}
          </div>
        )}
      </div>

      {/* ── What a scheduled scan does ── */}
      <div className="anim-fade-up stagger-2 card p-5">
        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-1)' }}>
          What a scheduled scan does
        </p>
        <ul className="space-y-2 text-[13px]" style={{ color: 'var(--text-2)' }}>
          <li className="flex gap-2">
            <span style={{ color: '#059669', fontWeight: 700 }}>✓</span>
            Re-crawls every page in this project (competitors included) and re-scores any page
            whose content changed. Unchanged pages keep their exact stored scores — no wasted spend.
          </li>
          <li className="flex gap-2">
            <span style={{ color: '#059669', fontWeight: 700 }}>✓</span>
            Refreshes search-visibility (SERP) data when the monthly snapshot is due.
          </li>
          <li className="flex gap-2">
            <span style={{ color: '#059669', fontWeight: 700 }}>✓</span>
            Updates the Overview, trend chart, and fix-first queue with the new results.
          </li>
          <li className="flex gap-2">
            <span style={{ color: 'var(--text-3)', fontWeight: 700 }}>ⓘ</span>
            Skipped automatically if a scan already ran in the previous {MANUAL_SKIP_HOURS / 24} days
            — no double runs.
          </li>
          <li className="flex gap-2">
            <span style={{ color: 'var(--text-3)', fontWeight: 700 }}>ⓘ</span>
            If {AUTO_PAUSE_AFTER} scheduled scans in a row fail (for example, the site starts
            blocking crawlers), the schedule pauses itself and notifies you instead of silently retrying.
          </li>
        </ul>
      </div>

      {/* ── Email notifications ── */}
      <div className="anim-fade-up stagger-3 card p-5">
        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>Email notifications</p>
          <button
            role="switch"
            aria-checked={schedule.emailEnabled}
            aria-label="Send an email after each scheduled scan"
            onClick={() => edit((d) => { d.emailEnabled = !d.emailEnabled; })}
            className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
            style={{ background: schedule.emailEnabled ? '#4f46e5' : 'var(--bg-3)' }}
          >
            <span
              className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
              style={{ left: schedule.emailEnabled ? '18px' : '2px' }}
            />
          </button>
        </div>

        {!emailReady && (
          <div className="mb-3 rounded-lg border px-3.5 py-2 text-[12px]"
            style={{ background: '#fffbeb', borderColor: '#fcd34d', color: '#92400e' }}>
            Email sending isn&apos;t configured on the server yet (RESEND_API_KEY). Scans will still
            run on schedule; emails start flowing as soon as the key is added.
          </div>
        )}

        <div style={schedule.emailEnabled ? undefined : { opacity: 0.55, pointerEvents: 'none' }}>
          <p className="text-[11px] font-bold uppercase tracking-[0.04em] mb-1.5" style={{ color: 'var(--text-3)' }}>
            Recipients
          </p>
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {schedule.recipients.map((r) => (
              <span key={r}
                className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px] font-medium"
                style={{ background: 'rgba(111,28,254,0.06)', borderColor: 'rgba(111,28,254,0.2)', color: '#6f1cfe' }}>
                {r}
                <button
                  aria-label={`Remove ${r}`}
                  onClick={() => edit((d) => { d.recipients = d.recipients.filter((x) => x !== r); })}
                  style={{ color: 'var(--text-3)' }}
                >
                  ✕
                </button>
              </span>
            ))}
            <input
              value={recipientInput}
              onChange={(e) => setRecipientInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRecipient(); } }}
              placeholder="name@company.com"
              className="rounded-lg border px-3 py-1.5 text-[13px] w-56"
              style={{ background: 'var(--bg-1)', borderColor: 'var(--border)', color: 'var(--text-1)' }}
            />
            <button className="btn-ghost text-[12.5px] px-3 py-1.5" onClick={addRecipient}>
              + Add
            </button>
          </div>

          <p className="text-[11px] font-bold uppercase tracking-[0.04em] mb-1.5" style={{ color: 'var(--text-3)' }}>
            When to send
          </p>
          <div className="space-y-1.5">
            {([
              ['always', 'After every scheduled scan — even if nothing moved (confirms it ran)'],
              ['changes', 'Only when something moved — a score changed or a page was added/removed'],
            ] as const).map(([mode, label]) => (
              <label key={mode} className="flex items-center gap-2.5 text-[13px] cursor-pointer" style={{ color: 'var(--text-2)' }}>
                <span
                  className="w-4 h-4 rounded-full border-2 flex-shrink-0"
                  style={schedule.sendMode === mode
                    ? { borderColor: '#4f46e5', borderWidth: 5 }
                    : { borderColor: 'var(--border-hi, #d1d5db)' }}
                  onClick={() => edit((d) => { d.sendMode = mode; })}
                />
                <span onClick={() => edit((d) => { d.sendMode = mode; })}>{label}</span>
              </label>
            ))}
          </div>
        </div>
      </div>

      {/* ── History ── */}
      <div className="anim-fade-up stagger-4 card p-5">
        <p className="text-sm font-semibold mb-3" style={{ color: 'var(--text-1)' }}>
          Scheduled scan history
        </p>
        {runs.length === 0 ? (
          <p className="text-[13px]" style={{ color: 'var(--text-3)' }}>
            No scheduled scans yet — history appears here after the first automatic run.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]" style={{ borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  {['Date', 'Result', 'Pages', 'Changed', 'Overall', ''].map((h) => (
                    <th key={h} className="text-left text-[11px] font-bold uppercase tracking-[0.04em] py-1.5 px-2"
                      style={{ color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const pill =
                    r.status === 'completed'
                      ? { text: '✓ Completed', bg: '#ecfdf5', fg: '#059669' }
                      : r.status === 'failed'
                        ? { text: '✕ Failed', bg: '#fef2f2', fg: '#dc2626' }
                        : r.status === 'running'
                          ? { text: 'Running…', bg: 'rgba(99,102,241,0.09)', fg: '#4f46e5' }
                          : { text: 'Skipped', bg: 'var(--bg-3)', fg: 'var(--text-3)' };
                  const s = r.summary;
                  const overall = s
                    ? s.avgBefore !== null && s.avgAfter !== null
                      ? `${s.avgBefore} → ${s.avgAfter}${s.gradeAfter ? ` (${s.gradeAfter})` : ''}`
                      : s.avgAfter !== null
                        ? `${s.avgAfter}${s.gradeAfter ? ` (${s.gradeAfter})` : ''}`
                        : '—'
                    : '—';
                  return (
                    <tr key={r.id}>
                      <td className="py-2 px-2 whitespace-nowrap" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>
                        {fmtDate(r.startedAt)}
                      </td>
                      <td className="py-2 px-2" style={{ borderBottom: '1px solid var(--border)' }}>
                        <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap"
                          style={{ background: pill.bg, color: pill.fg }}>
                          {pill.text}
                        </span>
                      </td>
                      <td className="py-2 px-2" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>
                        {s ? s.pages : '—'}
                      </td>
                      <td className="py-2 px-2" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>
                        {s ? s.changed : '—'}
                      </td>
                      <td className="py-2 px-2 whitespace-nowrap" style={{ color: 'var(--text-2)', borderBottom: '1px solid var(--border)' }}>
                        {overall}
                        {s && (s.improved > 0 || s.declined > 0) && (
                          <span className="ml-1.5 text-[12px]">
                            {s.improved > 0 && <span style={{ color: '#059669' }}>▲{s.improved}</span>}
                            {s.improved > 0 && s.declined > 0 && ' '}
                            {s.declined > 0 && <span style={{ color: '#dc2626' }}>▼{s.declined}</span>}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-[12px] max-w-[260px]" style={{ color: 'var(--text-3)', borderBottom: '1px solid var(--border)' }}>
                        {r.note ?? (r.emailStatus === 'sent' ? 'Email sent' : '')}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── How it works ── */}
      <div className="anim-fade-up stagger-5 rounded-[14px] border px-5 py-4"
        style={{ background: 'linear-gradient(90deg, rgba(99,102,241,0.06), rgba(111,28,254,0.06))', borderColor: 'rgba(99,102,241,0.18)' }}>
        <p className="text-[13.5px] font-bold mb-2.5" style={{ color: 'var(--text-1)' }}>How it works</p>
        <div className="flex items-center gap-2.5 flex-wrap text-[12.5px] font-semibold">
          {['You set a cadence', 'A daily sweep checks which projects are due', 'Due projects run the exact same pipeline as the Run button', 'Results hit the dashboard + the "what moved" email goes out'].map((step, i, arr) => (
            <span key={step} className="flex items-center gap-2.5">
              <span className="rounded-[10px] border px-3 py-1.5"
                style={i === 2
                  ? { background: 'var(--bg-1)', borderColor: '#a56bfb', color: '#6f1cfe' }
                  : { background: 'var(--bg-1)', borderColor: 'var(--border)', color: 'var(--text-2)' }}>
                {step}
              </span>
              {i < arr.length - 1 && <span style={{ color: 'var(--text-3)' }}>→</span>}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
