'use client';

// ─────────────────────────────────────────────────────────────
//  BusinessImpactView — the Business Impact page (exec surface).
//
//  Two-lane scenario ladder answering "if visibility improves,
//  what does it mean for the business?":
//    · Google Search — verified striking-distance demand × the
//      published CTR curve (the panel's existing modeled input).
//    · AI assistants — measured prompt-citation coverage scaled
//      against the client's own GA4 AI referral baseline.
//
//  Provenance tags on every figure: verified / modeled /
//  benchmark / client input. Missing inputs render "—", never a
//  made-up number. The AI lane's coverage→visits link is a
//  MODELING ASSUMPTION and is stated on the page in amber — do
//  not soften that copy without Wayne's sign-off.
// ─────────────────────────────────────────────────────────────

import { useMemo, useRef, useState } from 'react';
import {
  AIO_CTR_SOURCE,
  AIO_CTR_SOURCE_URL,
  AIO_FACTOR_UNCITED,
  CTR_SOURCE,
  CTR_SOURCE_URL,
} from '@/lib/rankings/ctr';
import {
  AI_VALUE_SOURCE,
  AI_VALUE_SOURCE_URL,
  CONV_SOURCE,
  CONV_SOURCE_URL,
  INDUSTRY_BENCHMARKS,
  computeAll,
  industryByKey,
  type AiBaseline,
  type GoogleBaseline,
  type ImpactInputs,
} from '@/lib/impact/model';

type TagKind = 'verified' | 'modeled' | 'benchmark' | 'client';

const TAG_STYLE: Record<TagKind, { bg: string; fg: string; label: string }> = {
  verified: { bg: 'rgba(5,150,105,0.12)', fg: '#047857', label: 'verified' },
  modeled: { bg: 'rgba(79,70,229,0.10)', fg: '#4f46e5', label: 'modeled' },
  benchmark: { bg: 'rgba(217,119,6,0.12)', fg: '#b45309', label: 'benchmark' },
  client: { bg: 'rgba(124,58,237,0.10)', fg: '#7c3aed', label: 'client input' },
};

function Tag({ kind }: { kind: TagKind }) {
  const s = TAG_STYLE[kind];
  return (
    <span
      className="inline-block align-middle rounded-full px-1.5 py-px text-[9.5px] font-bold uppercase tracking-[0.04em]"
      style={{ background: s.bg, color: s.fg }}
    >
      {s.label}
    </span>
  );
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString();
}

function money(n: number | null): string {
  if (n === null) return '—';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

function int(n: number | null): string {
  return n === null ? '—' : Math.round(n).toLocaleString();
}

const LANE_G = '#4f46e5'; // indigo — Google Search lane
const LANE_A = '#0e7490'; // teal — AI assistants lane

function LaneDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
      style={{ background: color }}
    />
  );
}

export default function BusinessImpactView({
  projectId,
  google,
  ai,
  initialInputs,
}: {
  projectId: string;
  google: GoogleBaseline | null;
  ai: AiBaseline;
  initialInputs: ImpactInputs;
}) {
  const [inputs, setInputs] = useState<ImpactInputs>(initialInputs);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scenarios = useMemo(() => computeAll(google, ai, inputs), [google, ai, inputs]);

  const volumesOk = Boolean(google?.volumesOk);
  const strikingVol = google?.strikingVol ?? 0;
  const googleReady = volumesOk && strikingVol > 0;
  const aiReady = ai.measured && ai.promptsTotal > 0;
  const dollarsReady = inputs.convRate !== null && inputs.leadValue !== null;

  // Debounced autosave — the inputs are the client's numbers and should
  // survive a reload without a separate Save ritual.
  function update(patch: Partial<ImpactInputs>) {
    const next = { ...inputs, ...patch };
    setInputs(next);
    setSaveState('saving');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/impact`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(next),
        });
        setSaveState(res.ok ? 'saved' : 'error');
      } catch {
        setSaveState('error');
      }
    }, 700);
  }

  function pickIndustry(key: string) {
    const bench = industryByKey(key || null);
    // Choosing an industry resets the conversion rate to its benchmark —
    // the field stays editable for a client override afterwards.
    update({ industry: bench?.key ?? null, convRate: bench?.organicConvRate ?? null });
  }

  const coverageNowPct =
    ai.promptsTotal > 0 ? Math.round((ai.promptsCited / ai.promptsTotal) * 100) : null;

  return (
    <div className="anim-fade-up space-y-5">
      {/* ── Header ── */}
      <div>
        <h2 className="text-[17px] font-bold" style={{ color: 'var(--text-1)' }}>
          Business Impact
        </h2>
        <p className="text-[13px] mt-0.5 max-w-3xl" style={{ color: 'var(--text-3)' }}>
          What improved visibility is worth, in the client&rsquo;s own numbers — two lanes:{' '}
          <span className="font-semibold" style={{ color: LANE_G }}>Google Search</span> and{' '}
          <span className="font-semibold" style={{ color: LANE_A }}>AI assistants</span>. Every
          figure is tagged with where it comes from: <Tag kind="verified" />{' '}
          <Tag kind="modeled" /> <Tag kind="benchmark" /> <Tag kind="client" />. Missing inputs
          show &ldquo;—&rdquo; rather than a guess.
        </p>
      </div>

      {/* ── Baseline: where visibility stands today ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="card p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] mb-2" style={{ color: 'var(--text-3)' }}>
            <LaneDot color={LANE_G} />
            Google Search today
          </p>
          {volumesOk ? (
            <div className="space-y-1.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              <div className="flex justify-between gap-3">
                <span>
                  Verified search demand on ranked terms <Tag kind="verified" />
                </span>
                <b style={{ color: 'var(--text-1)' }}>{compact(google!.totalDemand)} /mo</b>
              </div>
              <div className="flex justify-between gap-3">
                <span>
                  Captured in the top 10 today <Tag kind="verified" />
                </span>
                <b style={{ color: 'var(--text-1)' }}>
                  {google!.totalDemand > 0
                    ? `${Math.round((google!.top10Demand / google!.totalDemand) * 100)}%`
                    : '—'}
                </b>
              </div>
              <div className="flex justify-between gap-3">
                <span>
                  Striking distance (positions 11–20) <Tag kind="verified" />
                </span>
                <b style={{ color: 'var(--text-1)' }}>
                  {compact(strikingVol)} /mo · {google!.strikingKeywords} kw
                </b>
              </div>
              {google!.covered < google!.tracked && (
                <p className="text-[11.5px] pt-1" style={{ color: 'var(--text-3)' }}>
                  Volumes verified for {google!.covered} of {google!.tracked} tracked keywords —
                  the totals cover those rows only.
                </p>
              )}
            </div>
          ) : (
            <p className="text-[13px]" style={{ color: 'var(--text-3)' }}>
              Search volumes aren&rsquo;t verified for this project yet — they fill in with the
              next scan. The Google lane stays &ldquo;—&rdquo; until then; no substitute figures
              are shown.
            </p>
          )}
        </div>

        <div className="card p-4">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em] mb-2" style={{ color: 'var(--text-3)' }}>
            <LaneDot color={LANE_A} />
            AI assistants today
          </p>
          {aiReady ? (
            <div className="space-y-1.5 text-[13px]" style={{ color: 'var(--text-2)' }}>
              <div className="flex justify-between gap-3">
                <span>
                  Buyer prompts citing this brand <Tag kind="verified" />
                </span>
                <b style={{ color: 'var(--text-1)' }}>
                  {ai.promptsCited} of {ai.promptsTotal}
                  {coverageNowPct !== null ? ` (${coverageNowPct}%)` : ''}
                </b>
              </div>
              <div className="flex justify-between gap-3">
                <span>Prompts with engine checks on record</span>
                <b style={{ color: 'var(--text-1)' }}>
                  {ai.promptsChecked} of {ai.promptsTotal}
                </b>
              </div>
              <div className="flex justify-between gap-3">
                <span>Engines checked</span>
                <b style={{ color: 'var(--text-1)' }}>{ai.engines.length > 0 ? ai.engines.length : '—'}</b>
              </div>
            </div>
          ) : ai.promptsTotal > 0 ? (
            <p className="text-[13px]" style={{ color: 'var(--text-3)' }}>
              {ai.promptsTotal} buyer prompts exist but no engine checks have run yet — run
              checks from a page&rsquo;s Optimize workbench to measure citation coverage. The AI
              lane stays &ldquo;—&rdquo; until it&rsquo;s measured.
            </p>
          ) : (
            <p className="text-[13px]" style={{ color: 'var(--text-3)' }}>
              No buyer-prompt set yet — generate prompts from a page&rsquo;s Optimize workbench,
              then run engine checks. The AI lane stays &ldquo;—&rdquo; until it&rsquo;s measured.
            </p>
          )}
        </div>
      </div>

      {/* ── Assumptions ── */}
      <div className="card p-4">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <p className="text-[11px] font-bold uppercase tracking-[0.06em]" style={{ color: 'var(--text-3)' }}>
            Assumptions — benchmark defaults, the client&rsquo;s numbers win
          </p>
          <span className="text-[11px]" style={{ color: saveState === 'error' ? '#d97706' : 'var(--text-3)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Save failed — retry by editing again' : ''}
          </span>
        </div>
        <div className="grid gap-4 mt-3 sm:grid-cols-2 lg:grid-cols-5">
          <label className="block">
            <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--text-2)' }}>
              Industry <Tag kind="benchmark" />
            </span>
            <select
              value={inputs.industry ?? ''}
              onChange={(e) => pickIndustry(e.target.value)}
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            >
              <option value="">Select industry…</option>
              {INDUSTRY_BENCHMARKS.map((i) => (
                <option key={i.key} value={i.key}>
                  {i.label} — {i.organicConvRate}%
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--text-2)' }}>
              Visit → lead rate % <Tag kind="benchmark" />
            </span>
            <input
              type="number"
              step="0.1"
              min="0.05"
              max="50"
              value={inputs.convRate ?? ''}
              placeholder="pick industry"
              onChange={(e) =>
                update({ convRate: e.target.value === '' ? null : parseFloat(e.target.value) })
              }
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--text-2)' }}>
              Value per lead (USD) <Tag kind="client" />
            </span>
            <input
              type="number"
              step="50"
              min="0"
              value={inputs.leadValue ?? ''}
              placeholder="client's number"
              onChange={(e) =>
                update({ leadValue: e.target.value === '' ? null : parseFloat(e.target.value) })
              }
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--text-2)' }}>
              AI referral visits /mo <Tag kind="client" />
            </span>
            <input
              type="number"
              step="10"
              min="0"
              value={inputs.aiVisits ?? ''}
              placeholder="from GA4"
              onChange={(e) =>
                update({ aiVisits: e.target.value === '' ? null : parseFloat(e.target.value) })
              }
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            />
          </label>
          <label className="block">
            <span className="block text-[12px] font-semibold mb-1" style={{ color: 'var(--text-2)' }}>
              AI visitor premium × <Tag kind="benchmark" />
            </span>
            <input
              type="number"
              step="0.1"
              min="0.1"
              max="50"
              value={inputs.aiPremium}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                if (Number.isFinite(v)) update({ aiPremium: v });
              }}
              className="w-full rounded-lg border px-2.5 py-1.5 text-[13px]"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 mt-3 pt-3 border-t text-[12px]" style={{ borderColor: 'var(--border)', color: 'var(--text-3)' }}>
          <label className="inline-flex items-center gap-1.5 cursor-pointer" style={{ color: 'var(--text-2)' }}>
            <input
              type="checkbox"
              checked={inputs.aioDiscount}
              onChange={(e) => update({ aioDiscount: e.target.checked })}
            />
            Apply the AI Overview click discount to the Google lane (×{AIO_FACTOR_UNCITED} on
            AIO-exposed keywords — a second model, off by default)
          </label>
          <span>
            Conversion default: industry organic-search benchmark. Value per lead has NO public
            benchmark — it must come from the client. AI visits: GA4 referrals from
            chatgpt.com / perplexity.ai / gemini.google.com.
          </span>
        </div>
      </div>

      {/* ── The ladder ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {scenarios.map((s) => (
          <div
            key={s.def.key}
            className="card p-4"
            style={s.def.featured ? { boxShadow: '0 0 0 1.5px #818cf8' } : undefined}
          >
            <p
              className="text-[11px] font-bold uppercase tracking-[0.06em] flex justify-between"
              style={{ color: s.def.featured ? '#4f46e5' : 'var(--text-3)' }}
            >
              <span>{s.def.label}</span>
              {s.def.featured ? <span>★</span> : null}
            </p>
            <p className="text-[26px] font-bold mt-1.5 leading-none" style={{ color: 'var(--text-1)' }}>
              {money(s.totalAnnual)}
            </p>
            <p className="text-[11.5px] mt-1" style={{ color: 'var(--text-3)' }}>
              est. annual pipeline, both lanes
            </p>
            <p className="text-[12px] mt-1 pb-2.5 border-b" style={{ borderColor: 'var(--border)', color: 'var(--text-2)' }}>
              Google <b>{money(s.google.annual)}</b> &nbsp;·&nbsp; AI <b>{money(s.ai.annual)}</b>
            </p>

            {/* Google lane */}
            <div className="mt-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.05em]" style={{ color: 'var(--text-3)' }}>
                <LaneDot color={LANE_G} />
                Google Search
              </p>
              <p className="text-[12px] mt-0.5 mb-1.5" style={{ color: 'var(--text-2)' }}>
                Striking-distance keywords reach avg position {s.def.gPos}.
              </p>
              <table className="w-full text-[12px]" style={{ color: 'var(--text-2)' }}>
                <tbody>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">
                      CTR at position {s.def.gPos} <Tag kind="modeled" />
                    </td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {(s.google.ctr * 100).toFixed(1)}%
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">Est. visits / mo</td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {int(s.google.visits)}
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">
                      Est. leads / mo <Tag kind="benchmark" />
                    </td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {int(s.google.leads)}
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">Est. pipeline / yr</td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {money(s.google.annual)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* AI lane */}
            <div className="mt-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.05em]" style={{ color: 'var(--text-3)' }}>
                <LaneDot color={LANE_A} />
                AI assistants
              </p>
              <p className="text-[12px] mt-0.5 mb-1.5" style={{ color: 'var(--text-2)' }}>
                {aiReady && s.ai.targetCited !== null ? (
                  <>
                    Cited in <b>{s.ai.targetCited} of {ai.promptsTotal}</b> buyer prompts (
                    {Math.round((s.ai.targetCited / ai.promptsTotal) * 100)}%, vs{' '}
                    {coverageNowPct}% today).
                  </>
                ) : (
                  'Baseline not measured yet — run engine checks first.'
                )}
              </p>
              <table className="w-full text-[12px]" style={{ color: 'var(--text-2)' }}>
                <tbody>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">
                      Implied visit multiple <Tag kind="modeled" />
                    </td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {s.ai.multiple === null ? '—' : `×${s.ai.multiple}`}
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">Est. AI visits / mo</td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {int(s.ai.visits)}
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">
                      Lead rate × {inputs.aiPremium}× premium <Tag kind="benchmark" />
                    </td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {s.ai.leadRate === null ? '—' : `${s.ai.leadRate}%`}
                    </td>
                  </tr>
                  <tr className="border-t" style={{ borderColor: 'var(--border)' }}>
                    <td className="py-1">Est. pipeline / yr</td>
                    <td className="py-1 text-right font-semibold" style={{ color: 'var(--text-1)' }}>
                      {money(s.ai.annual)}
                    </td>
                  </tr>
                </tbody>
              </table>
              {s.ai.flooredBaseline && (
                <p className="text-[11px] mt-1.5" style={{ color: '#b45309' }}>
                  Measured coverage is 0 — the projection floors the baseline at 1 cited prompt.
                </p>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* ── The stated assumption + formulas ── */}
      <div className="card p-4">
        <div
          className="rounded-r-lg pl-4 pr-3 py-2.5 text-[12.5px]"
          style={{ borderLeft: '3px solid #b45309', background: 'rgba(217,119,6,0.06)', color: 'var(--text-2)' }}
        >
          <b style={{ color: '#92400e' }}>The AI lane&rsquo;s one leap of faith, stated out loud:</b>{' '}
          it assumes AI referral visits scale in proportion to prompt-citation coverage. That
          link is a modeling assumption — no published study measures it yet — which is why each
          card prints the implied visit multiple, and why the honest headline for this lane is{' '}
          <i>share of buyer moments</i> ({ai.promptsCited} of {ai.promptsTotal} prompts cited
          today), with dollars as the directional translation.
        </div>
        <p className="text-[11.5px] mt-3" style={{ color: 'var(--text-3)' }}>
          Google lane: striking-distance searches × CTR at target position × conversion rate ×
          value per lead × 12. &nbsp;AI lane: current AI visits × (target coverage ÷ measured
          coverage) × conversion rate × {inputs.aiPremium}× premium × value per lead × 12.
          {!dollarsReady && ' Dollar figures appear once a conversion rate and value per lead are set above.'}
          {!googleReady && volumesOk && ' No striking-distance demand in the latest scan, so the Google lane has nothing to project from.'}
        </p>
      </div>

      {/* ── Sources ── */}
      <p className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-3)' }}>
        Demand &amp; citation coverage: measured in this project&rsquo;s scans (DataForSEO
        clickstream volumes, row-level verified; engine checks are real provider responses).
        CTR curve:{' '}
        <a href={CTR_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
          {CTR_SOURCE}
        </a>{' '}
        — positions 1–10 only; below 10 assumed zero. AIO discount:{' '}
        <a href={AIO_CTR_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
          {AIO_CTR_SOURCE}
        </a>
        . Conversion benchmark:{' '}
        <a href={CONV_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
          {CONV_SOURCE}
        </a>
        . AI visitor premium ({inputs.aiPremium}×):{' '}
        <a href={AI_VALUE_SOURCE_URL} target="_blank" rel="noopener noreferrer" className="underline">
          {AI_VALUE_SOURCE}
        </a>{' '}
        (also: AI referral traffic +527% YoY in the same study — context only, deliberately not
        multiplied into the scenarios). All dollar outputs are projections and labeled as such.
      </p>
    </div>
  );
}
