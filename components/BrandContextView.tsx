'use client';

// ─────────────────────────────────────────────────────────────
//  BrandContextView — the Brand & Context (Setup) page body.
//  Sources card (upload / fetch URL) + the four editable profile
//  cards (Voice & tone, Audience, Company facts, Terminology &
//  style), each with a per-section master switch.
//
//  Editing model: everything edits local state; one Save button
//  PUTs the whole profile. Uploading/fetching a source runs the
//  server-side extraction and REPLACES local profile state with
//  the merged result (any unsaved edits are flushed to the server
//  first so extraction always merges into the latest edits).
//
//  ⚠️ Imports from lib/brand are types + pure helpers only —
//  never lib/brand/store or anything that touches Neon.
// ─────────────────────────────────────────────────────────────

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  emptyBrandProfile,
  summarizeBrandContext,
  BRAND_SECTION_LABELS,
  type BrandProfile,
  type BrandSectionKey,
  type BrandSourceMeta,
} from '@/lib/brand/types';

interface Props {
  projectId: string;
  projectName: string;
  initialProfile: BrandProfile | null;
  initialUpdatedAt: string | null;
  initialSources: BrandSourceMeta[];
}

const ACCEPT = '.pdf,.docx,.pptx,.md,.txt';

const KIND_BADGE: Record<BrandSourceMeta['kind'], { label: string; bg: string }> = {
  pdf: { label: 'PDF', bg: '#dc2626' },
  docx: { label: 'DOC', bg: '#2563eb' },
  pptx: { label: 'PPT', bg: '#c2410c' },
  text: { label: 'TXT', bg: '#475569' },
  url: { label: 'URL', bg: '#7c3aed' },
};

export default function BrandContextView({
  projectId,
  projectName,
  initialProfile,
  initialUpdatedAt,
  initialSources,
}: Props) {
  const router = useRouter();
  const [profile, setProfile] = useState<BrandProfile | null>(initialProfile);
  const [sources, setSources] = useState<BrandSourceMeta[]>(initialSources);
  const [updatedAt, setUpdatedAt] = useState<string | null>(initialUpdatedAt);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<'' | 'extract' | 'save'>('');
  const [error, setError] = useState('');
  const [urlInput, setUrlInput] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const summary = summarizeBrandContext(profile);

  function edit(mutate: (p: BrandProfile) => void) {
    setProfile((prev) => {
      const next = structuredClone(prev ?? emptyBrandProfile());
      mutate(next);
      return next;
    });
    setDirty(true);
  }

  // ── Server interactions ─────────────────────────────────────

  async function saveProfile(p: BrandProfile | null): Promise<boolean> {
    if (!p) return true;
    const res = await fetch(`/api/projects/${projectId}/brand`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ profile: p }),
    });
    if (!res.ok) {
      const j = await res.json().catch(() => null);
      setError(j?.error ?? 'Failed to save the profile');
      return false;
    }
    setUpdatedAt(new Date().toISOString());
    return true;
  }

  async function onSave() {
    if (!profile) return;
    setError('');
    setBusy('save');
    try {
      if (await saveProfile(profile)) {
        setDirty(false);
        router.refresh(); // rail "On" badge reads server state
      }
    } finally {
      setBusy('');
    }
  }

  async function addSource(body: FormData | { url: string }) {
    setError('');
    setBusy('extract');
    try {
      // Flush unsaved edits first so extraction merges into what's on screen.
      if (dirty && profile) {
        if (!(await saveProfile(profile))) return;
        setDirty(false);
      }
      const res = await fetch(`/api/projects/${projectId}/brand/sources`, {
        method: 'POST',
        ...(body instanceof FormData
          ? { body }
          : {
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
      const j = await res.json().catch(() => null);
      if (!res.ok) {
        setError(j?.error ?? 'Failed to add that source');
        if (j?.sources) setSources(j.sources);
        return;
      }
      setProfile(j.profile);
      setSources(j.sources);
      setUpdatedAt(new Date().toISOString());
      setDirty(false);
      setUrlInput('');
      router.refresh();
    } catch {
      setError('Failed to add that source — check your connection and try again');
    } finally {
      setBusy('');
    }
  }

  function onFilePicked(files: FileList | null) {
    const f = files?.[0];
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    void addSource(fd);
    if (fileRef.current) fileRef.current.value = '';
  }

  async function removeSource(id: string) {
    setError('');
    const res = await fetch(`/api/projects/${projectId}/brand/sources/${id}`, {
      method: 'DELETE',
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) {
      setError(j?.error ?? 'Failed to remove the source');
      return;
    }
    setSources(j.sources ?? sources.filter((s) => s.id !== id));
  }

  // ── Render ──────────────────────────────────────────────────

  const p = profile;

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      {/* Header — relative z-30 per the stacking-context rule (anim-fade-up
          creates a stacking context; anything absolutely positioned in later
          cards would otherwise paint over it). */}
      <div className="anim-fade-up relative z-30 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: 'var(--text-1)', letterSpacing: '-0.02em' }}>
            Brand &amp; Context
          </h1>
          <p className="text-sm mt-1 max-w-2xl leading-relaxed" style={{ color: 'var(--text-3)' }}>
            Upload brand guidelines or company info once for {projectName}. Every AI-written draft
            and optimization packet in this project is generated against the approved profile below.
          </p>
        </div>
        <button
          onClick={onSave}
          disabled={!dirty || busy !== ''}
          className="rounded-lg px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-40"
          style={{ background: '#4f46e5' }}
        >
          {busy === 'save' ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
        </button>
      </div>

      {/* Status line */}
      {summary.active ? (
        <div
          className="anim-fade-up flex items-center gap-2 rounded-xl border px-4 py-2.5 text-[13px] font-medium"
          style={{ background: 'rgba(5,150,105,0.07)', borderColor: 'rgba(5,150,105,0.25)', color: '#065f46' }}
        >
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: '#059669' }} />
          Brand profile active — {summary.sectionsOn} of {summary.sectionsTotal} sections applied to
          AI-written content
          {updatedAt && (
            <span className="font-normal" style={{ color: 'var(--text-3)' }}>
              · updated {updatedAt.slice(0, 10)}
            </span>
          )}
        </div>
      ) : (
        <div
          className="anim-fade-up rounded-xl border px-4 py-2.5 text-[13px]"
          style={{ background: 'var(--bg-2)', borderColor: 'var(--border)', color: 'var(--text-2)' }}
        >
          No brand profile yet — add a source below (or fill the cards in by hand) and AI-written
          content will adapt to it.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError('')} className="font-bold ml-3">×</button>
        </div>
      )}

      {/* ── Sources ── */}
      <div className="anim-fade-up stagger-1 card p-5">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
            Sources
          </p>
          <span className="text-[11px]" style={{ color: 'var(--text-3)' }}>
            PDF · DOCX · PPTX · MD · TXT · URL — 4 MB max per file
          </span>
        </div>

        <div
          className="rounded-xl border-2 border-dashed px-6 py-7 text-center"
          style={{ borderColor: 'var(--border-hi)', background: 'var(--bg-2)' }}
        >
          <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
            {busy === 'extract' ? 'Extracting brand profile…' : 'Add brand guidelines or company docs'}
          </p>
          <p className="text-xs mt-1 max-w-lg mx-auto" style={{ color: 'var(--text-3)' }}>
            Style guides, messaging frameworks, about pages, personas, boilerplate — the AI extracts
            what matters into the profile below for you to review and edit.
          </p>
          <div className="mt-3 flex items-center justify-center gap-2 flex-wrap">
            <input
              ref={fileRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => onFilePicked(e.target.files)}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={busy !== ''}
              className="rounded-lg px-3.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
              style={{ background: '#4f46e5' }}
            >
              {busy === 'extract' ? 'Working…' : '⇪ Upload file'}
            </button>
            <span className="text-[11px] font-bold" style={{ color: 'var(--text-3)' }}>OR</span>
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && urlInput.trim() && busy === '') void addSource({ url: urlInput.trim() });
              }}
              placeholder="https://client.com/about"
              className="rounded-lg border px-3 py-1.5 text-xs w-64 max-w-full"
              style={{ borderColor: 'var(--border-hi)', background: 'var(--bg-1)', color: 'var(--text-1)' }}
            />
            <button
              onClick={() => urlInput.trim() && void addSource({ url: urlInput.trim() })}
              disabled={busy !== '' || !urlInput.trim()}
              className="rounded-lg border px-3 py-1.5 text-xs font-semibold disabled:opacity-50"
              style={{ borderColor: 'var(--border-hi)', color: 'var(--text-2)', background: 'var(--bg-1)' }}
            >
              Fetch
            </button>
          </div>
        </div>

        {sources.length > 0 && (
          <div className="mt-3 space-y-2">
            {sources.map((s) => (
              <div
                key={s.id}
                className="flex items-center gap-3 rounded-lg border px-3 py-2"
                style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}
              >
                <span
                  className="w-8 h-8 rounded-md flex items-center justify-center text-[10px] font-extrabold text-white flex-shrink-0"
                  style={{ background: KIND_BADGE[s.kind].bg }}
                >
                  {KIND_BADGE[s.kind].label}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--text-1)' }}>
                    {s.name}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--text-3)' }}>
                    {s.detail} · {s.createdAt.slice(0, 10)}
                  </p>
                </div>
                <span
                  className="ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold flex-shrink-0"
                  style={
                    s.status === 'done'
                      ? { background: 'rgba(5,150,105,0.1)', color: '#059669' }
                      : { background: 'rgba(220,38,38,0.1)', color: '#dc2626' }
                  }
                >
                  {s.status === 'done' ? '✓ Extracted' : s.error ?? 'Error'}
                </span>
                <button
                  onClick={() => void removeSource(s.id)}
                  title="Remove this source record (already-extracted profile content stays — edit the cards to change it)"
                  className="text-sm px-1 flex-shrink-0"
                  style={{ color: 'var(--text-3)' }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Profile cards ── */}
      <div className="anim-fade-up stagger-2 flex items-baseline gap-2.5">
        <h2 className="text-base font-bold" style={{ color: 'var(--text-1)' }}>
          Brand profile
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-3)' }}>
          extracted from your sources — review and edit anything; switch a card off to keep it out
          of AI writing
        </span>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        {/* Voice & tone */}
        <SectionCard
          title="🗣 Voice & tone"
          section="voice"
          profile={p}
          onToggle={(on) => edit((d) => { d.enabled.voice = on; })}
        >
          <Slider
            left="Formal" right="Conversational"
            value={p?.voice.sliders.formalCasual ?? 50}
            onChange={(v) => edit((d) => { d.voice.sliders.formalCasual = v; })}
          />
          <Slider
            left="Reserved" right="Bold"
            value={p?.voice.sliders.reservedBold ?? 50}
            onChange={(v) => edit((d) => { d.voice.sliders.reservedBold = v; })}
          />
          <Slider
            left="Technical" right="Plain-spoken"
            value={p?.voice.sliders.technicalPlain ?? 50}
            onChange={(v) => edit((d) => { d.voice.sliders.technicalPlain = v; })}
          />
          <Field label="Tone descriptors">
            <ChipEditor
              items={p?.voice.descriptors ?? []}
              placeholder="e.g. Confident, not boastful"
              onChange={(items) => edit((d) => { d.voice.descriptors = items; })}
            />
          </Field>
          <Field label="Point of view / person">
            <textarea
              value={p?.voice.pointOfView ?? ''}
              onChange={(e) => edit((d) => { d.voice.pointOfView = e.target.value; })}
              rows={2}
              placeholder={`e.g. Second person ("you") for readers; "we" for the company.`}
              className="brand-input"
            />
          </Field>
          <SourceNote note={p?.voice.sourceNote} />
        </SectionCard>

        {/* Audience */}
        <SectionCard
          title="👥 Audience"
          section="audience"
          profile={p}
          onToggle={(on) => edit((d) => { d.enabled.audience = on; })}
        >
          {(p?.audience.personas ?? []).map((per, i) => (
            <div
              key={i}
              className="rounded-lg border px-3 py-2.5 mb-2"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-2)' }}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <input
                  value={per.name}
                  onChange={(e) => edit((d) => { d.audience.personas[i].name = e.target.value; })}
                  placeholder="Persona name"
                  className="brand-input flex-1 !py-1 font-semibold"
                />
                <select
                  value={per.role}
                  onChange={(e) => edit((d) => { d.audience.personas[i].role = e.target.value as 'primary' | 'secondary'; })}
                  className="brand-input !w-auto !py-1 text-xs"
                >
                  <option value="primary">Primary</option>
                  <option value="secondary">Secondary</option>
                </select>
                <button
                  onClick={() => edit((d) => { d.audience.personas.splice(i, 1); })}
                  className="text-sm"
                  style={{ color: 'var(--text-3)' }}
                >
                  ✕
                </button>
              </div>
              <textarea
                value={per.description}
                onChange={(e) => edit((d) => { d.audience.personas[i].description = e.target.value; })}
                rows={2}
                placeholder="Who they are + how to write for them"
                className="brand-input"
              />
            </div>
          ))}
          <button
            onClick={() => edit((d) => { d.audience.personas.push({ name: '', role: d.audience.personas.length ? 'secondary' : 'primary', description: '' }); })}
            className="rounded-lg border px-3 py-1.5 text-xs font-semibold"
            style={{ borderColor: 'var(--border-hi)', color: 'var(--text-2)' }}
          >
            + Add audience
          </button>
          <SourceNote note={p?.audience.sourceNote} />
        </SectionCard>

        {/* Company facts */}
        <SectionCard
          title="🏢 Company facts"
          section="facts"
          profile={p}
          onToggle={(on) => edit((d) => { d.enabled.facts = on; })}
        >
          <Field label="Boilerplate">
            <textarea
              value={p?.facts.boilerplate ?? ''}
              onChange={(e) => edit((d) => { d.facts.boilerplate = e.target.value; })}
              rows={3}
              placeholder="Standard company description paragraph"
              className="brand-input"
            />
          </Field>
          <Field label="Products / services to reference">
            <ChipEditor
              items={p?.facts.products ?? []}
              placeholder="Add a product name"
              onChange={(items) => edit((d) => { d.facts.products = items; })}
            />
          </Field>
          <Field label="Approved proof points — the ONLY stats the AI may cite">
            <ChipEditor
              items={p?.facts.proofPoints ?? []}
              placeholder={'e.g. "400+ customers since 2014"'}
              onChange={(items) => edit((d) => { d.facts.proofPoints = items; })}
              wide
            />
            <p className="text-[11px] mt-1" style={{ color: 'var(--text-3)' }}>
              Generation prompts whitelist this list; the AI never introduces other company figures.
            </p>
          </Field>
          <SourceNote note={p?.facts.sourceNote} />
        </SectionCard>

        {/* Terminology & style */}
        <SectionCard
          title="📖 Terminology & style"
          section="style"
          profile={p}
          onToggle={(on) => edit((d) => { d.enabled.style = on; })}
        >
          <Field label="Preferred terms">
            <ChipEditor
              items={p?.style.preferredTerms ?? []}
              placeholder="Add a preferred term"
              onChange={(items) => edit((d) => { d.style.preferredTerms = items; })}
            />
          </Field>
          <Field label="Never use">
            <ChipEditor
              items={p?.style.bannedTerms ?? []}
              placeholder="Add a banned word/phrase"
              onChange={(items) => edit((d) => { d.style.bannedTerms = items; })}
              danger
            />
          </Field>
          <div className="grid grid-cols-2 gap-2.5 mb-3">
            <Field label="Headings">
              <select
                value={p?.style.headingCase ?? ''}
                onChange={(e) => edit((d) => { d.style.headingCase = (e.target.value || null) as 'sentence' | 'title' | null; })}
                className="brand-input"
              >
                <option value="">No rule</option>
                <option value="sentence">Sentence case</option>
                <option value="title">Title case</option>
              </select>
            </Field>
            <Field label="Max reading grade">
              <select
                value={p?.style.maxReadingGrade ?? ''}
                onChange={(e) => edit((d) => { d.style.maxReadingGrade = e.target.value ? Number(e.target.value) : null; })}
                className="brand-input"
              >
                <option value="">No limit</option>
                {[6, 7, 8, 9, 10, 11, 12].map((g) => (
                  <option key={g} value={g}>Grade {g}</option>
                ))}
              </select>
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px] mb-3" style={{ color: 'var(--text-2)' }}>
            <input
              type="checkbox"
              checked={p?.style.noExclamations ?? false}
              onChange={(e) => edit((d) => { d.style.noExclamations = e.target.checked; })}
            />
            No exclamation points
          </label>
          <Field label="Other style rules">
            <textarea
              value={p?.style.styleRules ?? ''}
              onChange={(e) => edit((d) => { d.style.styleRules = e.target.value; })}
              rows={2}
              placeholder="e.g. Oxford comma · spell out numbers one–nine"
              className="brand-input"
            />
          </Field>
          <Field label="Compliance notes">
            <textarea
              value={p?.style.complianceNotes ?? ''}
              onChange={(e) => edit((d) => { d.style.complianceNotes = e.target.value; })}
              rows={2}
              placeholder="e.g. Never promise specific ROI figures."
              className="brand-input"
            />
          </Field>
          <SourceNote note={p?.style.sourceNote} />
        </SectionCard>
      </div>

      {/* How this is used */}
      <div
        className="anim-fade-up stagger-3 rounded-xl border px-5 py-4"
        style={{
          background: 'linear-gradient(90deg, rgba(99,102,241,0.06), rgba(111,28,254,0.05))',
          borderColor: 'rgba(99,102,241,0.2)',
        }}
      >
        <p className="text-[13px] font-bold mb-2" style={{ color: 'var(--text-1)' }}>
          How this is used
        </p>
        <div className="flex items-center gap-2 flex-wrap text-[12px] font-medium" style={{ color: 'var(--text-2)' }}>
          <span className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}>You add sources</span>
          <span style={{ color: 'var(--text-3)' }}>→</span>
          <span className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}>AI extracts a profile → you approve &amp; edit it</span>
          <span style={{ color: 'var(--text-3)' }}>→</span>
          <span className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'rgba(111,28,254,0.35)', background: 'var(--bg-1)', color: '#6f1cfe' }}>
            Rewrites &amp; generated sections are written against it
          </span>
          <span style={{ color: 'var(--text-3)' }}>→</span>
          <span className="rounded-lg border px-2.5 py-1.5" style={{ borderColor: 'var(--border)', background: 'var(--bg-1)' }}>
            The <Link href={`/projects/${projectId}/optimize`} className="underline">workbench</Link> runs a deterministic brand check on drafts
          </span>
        </div>
      </div>

    </div>
  );
}

// ── Small building blocks ─────────────────────────────────────

function SectionCard({
  title,
  section,
  profile,
  onToggle,
  children,
}: {
  title: string;
  section: BrandSectionKey;
  profile: BrandProfile | null;
  onToggle: (on: boolean) => void;
  children: React.ReactNode;
}) {
  const on = profile?.enabled[section] ?? true;
  return (
    <div className="card p-5" style={on ? undefined : { background: 'var(--bg-2)' }}>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-sm font-semibold" style={{ color: 'var(--text-1)' }}>
          {title}
        </p>
        <button
          role="switch"
          aria-checked={on}
          aria-label={`Use ${BRAND_SECTION_LABELS[section]} in AI writing`}
          title={on ? 'Included in AI writing — click to exclude' : 'Excluded from AI writing — click to include'}
          onClick={() => onToggle(!on)}
          className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0"
          style={{ background: on ? '#4f46e5' : 'var(--bg-3)' }}
        >
          <span
            className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all"
            style={{ left: on ? '18px' : '2px' }}
          />
        </button>
      </div>
      <div style={on ? undefined : { opacity: 0.55 }}>{children}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <p
        className="text-[11px] font-bold uppercase tracking-[0.04em] mb-1.5"
        style={{ color: 'var(--text-3)' }}
      >
        {label}
      </p>
      {children}
    </div>
  );
}

function SourceNote({ note }: { note?: string }) {
  if (!note?.trim()) return null;
  return (
    <p className="text-[11px] mt-2" style={{ color: 'var(--text-3)' }}>
      from {note}
    </p>
  );
}

function Slider({
  left,
  right,
  value,
  onChange,
}: {
  left: string;
  right: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-2.5 mb-2.5 text-[11.5px]" style={{ color: 'var(--text-3)' }}>
      <span className="w-[74px] text-right flex-shrink-0">{left}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-indigo-600"
        aria-label={`${left} to ${right}`}
      />
      <span className="w-[92px] flex-shrink-0">{right}</span>
    </div>
  );
}

function ChipEditor({
  items,
  onChange,
  placeholder,
  danger,
  wide,
}: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder: string;
  danger?: boolean;
  wide?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = draft.trim();
    if (!t || items.includes(t)) { setDraft(''); return; }
    onChange([...items, t]);
    setDraft('');
  };
  return (
    <div>
      {items.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {items.map((it) => (
            <span
              key={it}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] font-medium ${wide ? 'max-w-full' : ''}`}
              style={
                danger
                  ? { background: 'rgba(220,38,38,0.06)', borderColor: 'rgba(220,38,38,0.25)', color: '#b91c1c' }
                  : { background: 'rgba(99,102,241,0.07)', borderColor: 'rgba(99,102,241,0.22)', color: '#4f46e5' }
              }
            >
              <span className={wide ? 'truncate' : ''}>{it}</span>
              <button
                onClick={() => onChange(items.filter((x) => x !== it))}
                className="font-bold opacity-60 hover:opacity-100"
                aria-label={`Remove ${it}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); add(); }
        }}
        onBlur={add}
        placeholder={placeholder}
        className="brand-input"
      />
    </div>
  );
}
