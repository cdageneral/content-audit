"use client";

// ─────────────────────────────────────────────────────────────
//  Optimize Workbench — per-URL content editor + score simulator.
//  Left: structured editor (everything the scorer sees is editable
//  here — title, meta, markdown body, metadata, links).
//  Right: baseline dimension scores with rationale/evidence, AI
//  rewrite actions, and the latest simulation result.
// ─────────────────────────────────────────────────────────────

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ALL_DIMENSIONS,
  DIMENSION_LABELS,
  DIMENSION_GROUPS,
} from "@/lib/types";
import type {
  DimensionScores,
  DimensionRationale,
  DimensionEvidence,
  Recommendation,
  ScoreDimension,
  PageMetadata,
} from "@/lib/types";

// ── Serialized (client-safe) shapes passed from the server page ──

export interface WorkbenchBaseline {
  scores: DimensionScores;
  rationale: DimensionRationale;
  evidence: DimensionEvidence;
  recommendations: Recommendation[];
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  modelVersion: string;
  scoredAt: string; // ISO
  /** null = scored before the determinism engine (no content fingerprint) — deltas vs simulations won't line up until a re-audit. */
  contentHash?: string | null;
}

export interface WorkbenchDraft {
  id: string;
  version: number;
  title: string;
  metaDescription: string;
  bodyMd: string;
  metadata: PageMetadata;
  internalLinks: string[];
  externalLinks: string[];
  createdAt: string; // ISO
}

export interface WorkbenchSimulation {
  id: string;
  draftId: string;
  scores: DimensionScores;
  rationale: DimensionRationale;
  overallScore: number;
  grade: "A" | "B" | "C" | "D" | "F";
  modelVersion: string;
  promptVersion: string;
  reused: boolean;
  createdAt: string; // ISO
}

export interface WorkbenchProps {
  projectId: string;
  projectName: string;
  pageId: string;
  url: string;
  baseline: WorkbenchBaseline | null;
  benchmark: { name: string; score: number } | null;
  seed: {
    title: string;
    metaDescription: string;
    bodyMd: string;
    metadata: PageMetadata;
    internalLinks: string[];
    externalLinks: string[];
  };
  drafts: WorkbenchDraft[];
  simulations: WorkbenchSimulation[]; // latest per draft
  promptVersion: string;
  scoringModel: string;
}

type Tab = "content" | "details" | "diff";

// Dimensions with a live-web research action (structural dimensions are
// served by AI rewrite instead).
const RESEARCH_DIMS: Partial<
  Record<ScoreDimension, { button: string; header: string }>
> = {
  edgeCases: { button: "🔎 Fetch Real Edge Cases", header: "Real edge cases found for this page" },
  impliedQuestions: { button: "🔎 Fetch Real Questions", header: "Questions people actually ask" },
  fanOutQueries: { button: "🔎 Fetch Related Topics", header: "Adjacent topics worth covering" },
  citable: { button: "🔎 Fetch Authoritative Sources", header: "Authoritative sources worth citing" },
  paaCoverage: { button: "🔎 Fetch PAA Questions", header: "People-Also-Ask questions to answer" },
};

interface ResearchSuggestion {
  title: string;
  summary: string;
  sourceUrl: string;
  sourceTitle: string;
}

interface ResearchState {
  suggestions: ResearchSuggestion[];
  cached: boolean;
  fetchedAt: string;
}

interface VerifyResult {
  matched: boolean;
  realOverall: number;
  realGrade: "A" | "B" | "C" | "D" | "F";
  simulatedOverall: number;
  fidelity?: {
    matchPct: number;
    titleMatch: boolean;
    metaMatch: boolean;
    missingHeadings: string[];
    extraHeadings: string[];
    publishedNotInDraft: string[];
    draftNotInPublished: string[];
  };
  verifiedAt: string;
}

interface EditorState {
  title: string;
  metaDescription: string;
  bodyMd: string;
  metadata: PageMetadata;
  internalLinks: string[];
  externalLinks: string[];
}

export default function OptimizeWorkbench(props: WorkbenchProps) {
  const { projectId, pageId, url, baseline, benchmark, seed } = props;

  const [drafts, setDrafts] = useState<WorkbenchDraft[]>(props.drafts);
  const [sims, setSims] = useState<WorkbenchSimulation[]>(props.simulations);
  const newestDraft = drafts.length ? drafts[0] : null;

  const [activeDraftId, setActiveDraftId] = useState<string | null>(
    newestDraft ? newestDraft.id : null
  );
  const [editor, setEditor] = useState<EditorState>(() =>
    newestDraft ? draftToEditor(newestDraft) : { ...seed }
  );
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("content");
  const [expanded, setExpanded] = useState<ScoreDimension | null>(null);
  const [busy, setBusy] = useState<
    "" | "save" | "simulate" | "rewrite" | "research" | "generate" | "verify"
  >("");
  // Seconds elapsed on whatever action is currently running, so every busy
  // button can show a live "still working" timer. Resets each time a new
  // action starts and stops ticking the moment busy clears.
  const [busySecs, setBusySecs] = useState(0);
  useEffect(() => {
    if (busy === "") return;
    setBusySecs(0);
    const id = setInterval(() => setBusySecs((s) => s + 1), 1000);
    return () => clearInterval(id);
  }, [busy]);
  const [verify, setVerify] = useState<VerifyResult | null>(null);
  const [error, setError] = useState<string>("");
  const [proposal, setProposal] = useState<{
    dims: ScoreDimension[];
    markdown: string;
    mode: "replace" | "append";
  } | null>(null);
  const [research, setResearch] = useState<Partial<Record<ScoreDimension, ResearchState>>>({});
  const [checkedSug, setCheckedSug] = useState<Record<string, boolean>>({});

  const activeSim = useMemo(() => {
    if (!activeDraftId) return null;
    const found = sims.filter((s) => s.draftId === activeDraftId);
    return found.length ? found[0] : null;
  }, [sims, activeDraftId]);

  const derived = useMemo(() => deriveStats(editor, url), [editor, url]);

  // ── Actions ─────────────────────────────────────────────────

  function update<K extends keyof EditorState>(key: K, value: EditorState[K]) {
    setEditor((e) => ({ ...e, [key]: value }));
    setDirty(true);
  }

  async function saveDraft(): Promise<WorkbenchDraft | null> {
    setBusy("save");
    setError("");
    try {
      const res = await fetch(`/api/optimize/${pageId}/draft`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, ...editor }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const d = data.draft as {
        id: string;
        version: number;
        createdAt: string;
      };
      const saved: WorkbenchDraft = { ...editor, id: d.id, version: d.version, createdAt: d.createdAt };
      setDrafts((prev) => [saved, ...prev]);
      setActiveDraftId(saved.id);
      setDirty(false);
      return saved;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      return null;
    } finally {
      setBusy("");
    }
  }

  async function simulate() {
    setError("");
    let draftId = activeDraftId;
    if (dirty || !draftId) {
      const saved = await saveDraft();
      if (!saved) return;
      draftId = saved.id;
    }
    setBusy("simulate");
    try {
      const res = await fetch(`/api/optimize/${pageId}/simulate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      const sim = data.simulation as WorkbenchSimulation;
      setSims((prev) => [sim, ...prev.filter((s) => s.draftId !== sim.draftId)]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Simulation failed");
    } finally {
      setBusy("");
    }
  }

  async function rewrite(dims: ScoreDimension[]) {
    setBusy("rewrite");
    setError("");
    try {
      const res = await fetch(`/api/optimize/${pageId}/rewrite`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetDimensions: dims,
          title: editor.title,
          metaDescription: editor.metaDescription,
          bodyMd: editor.bodyMd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setProposal({ dims, markdown: data.markdown as string, mode: "replace" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rewrite failed");
    } finally {
      setBusy("");
    }
  }

  async function fetchResearch(dim: ScoreDimension, refresh = false) {
    setBusy("research");
    setError("");
    try {
      const res = await fetch(`/api/optimize/${pageId}/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dimension: dim, refresh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setResearch((r) => ({
        ...r,
        [dim]: {
          suggestions: data.suggestions as ResearchSuggestion[],
          cached: data.cached === true,
          fetchedAt: (data.fetchedAt as string) ?? "",
        },
      }));
      // Pre-check everything — most users want most of what was found.
      const next: Record<string, boolean> = {};
      (data.suggestions as ResearchSuggestion[]).forEach((_, i) => {
        next[`${dim}:${i}`] = true;
      });
      setCheckedSug((c) => ({ ...c, ...next }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Research failed");
    } finally {
      setBusy("");
    }
  }

  async function generateCopy(dim: ScoreDimension) {
    const state = research[dim];
    if (!state) return;
    const selected = state.suggestions.filter((_, i) => checkedSug[`${dim}:${i}`]);
    if (selected.length === 0) return;
    setBusy("generate");
    setError("");
    try {
      const res = await fetch(`/api/optimize/${pageId}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dimension: dim,
          selected,
          title: editor.title,
          metaDescription: editor.metaDescription,
          bodyMd: editor.bodyMd,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setProposal({ dims: [dim], markdown: data.markdown as string, mode: "append" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy generation failed");
    } finally {
      setBusy("");
    }
  }

  async function verifyPublished() {
    if (!activeDraftId || !activeSim) return;
    setBusy("verify");
    setError("");
    try {
      const res = await fetch(`/api/optimize/${pageId}/verify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: activeDraftId, simulationId: activeSim.id }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setVerify(data as VerifyResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verification failed");
    } finally {
      setBusy("");
    }
  }

  function selectVersion(id: string) {
    setVerify(null);
    if (id === "__baseline__") {
      setActiveDraftId(null);
      setEditor({ ...seed });
      setDirty(false);
      return;
    }
    const d = drafts.filter((x) => x.id === id)[0];
    if (d) {
      setActiveDraftId(d.id);
      setEditor(draftToEditor(d));
      setDirty(false);
    }
  }

  const weakestDims = useMemo(() => {
    if (!baseline) return [] as ScoreDimension[];
    return [...ALL_DIMENSIONS]
      .sort((a, b) => baseline.scores[a] - baseline.scores[b])
      .slice(0, 3);
  }, [baseline]);

  const exportHref = activeDraftId
    ? `/api/optimize/${pageId}/export?draftId=${activeDraftId}${
        activeSim ? `&simulationId=${activeSim.id}` : ""
      }`
    : null;

  // ── Render ──────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1 text-xs" style={{ color: "var(--text-3)" }}>
            <Link href={`/projects/${projectId}`} className="hover:underline">
              ← {props.projectName}
            </Link>
            <span>/</span>
            <span>Optimize</span>
          </div>
          <h1 className="text-xl font-bold flex items-center gap-2.5 flex-wrap" style={{ color: "var(--text-1)" }}>
            <span className="truncate max-w-xl">{editor.title || url}</span>
            {baseline && (
              <span className={`grade-${baseline.grade} rounded-md px-2 py-0.5 text-sm font-bold`}>
                {baseline.grade} · {baseline.overallScore}
              </span>
            )}
          </h1>
          <p className="text-xs font-mono mt-1 truncate" style={{ color: "var(--text-3)" }}>
            {url}
          </p>
          <p className="text-[11px] mt-1" style={{ color: "var(--text-3)" }}>
            Baseline: {baseline ? `audited ${baseline.scoredAt.slice(0, 10)} · ${baseline.modelVersion}` : "no completed audit for this page"} · prompt {props.promptVersion}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={activeDraftId ?? "__baseline__"}
            onChange={(e) => selectVersion(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs text-slate-700"
          >
            <option value="__baseline__">Original (baseline)</option>
            {drafts.map((d) => {
              const s = sims.filter((x) => x.draftId === d.id)[0];
              return (
                <option key={d.id} value={d.id}>
                  Draft v{d.version}
                  {s ? ` — simulated ${s.overallScore}` : ""}
                </option>
              );
            })}
          </select>
          {activeSim && activeDraftId && (
            <button
              onClick={verifyPublished}
              disabled={busy !== ""}
              title="Re-crawl the live URL and check whether the published page reproduces the simulated score"
              className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50 transition-colors"
            >
              {busy === "verify" ? (
                <Working label="Verifying…" secs={busySecs} />
              ) : (
                "✓ Verify Published"
              )}
            </button>
          )}
          {exportHref ? (
            <a
              href={exportHref}
              className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50 transition-colors"
            >
              ⬇ Export Packet
            </a>
          ) : (
            <span
              title="Save a draft first"
              className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-semibold text-slate-300 cursor-not-allowed"
            >
              ⬇ Export Packet
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-xs text-red-700 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError("")} className="font-bold ml-3">×</button>
        </div>
      )}

      {baseline && baseline.contentHash === null && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-2.5 text-xs text-amber-800 flex items-start gap-2">
          <span>⚠</span>
          <span>
            <b>Re-run the audit before optimizing this page.</b> Its baseline was scored by an older
            version of the scoring engine, so simulated deltas won&apos;t line up with the baseline
            numbers. Run the project audit from the{" "}
            <Link href={`/projects/${projectId}`} className="underline">
              project page
            </Link>{" "}
            first — fresh baselines match simulations exactly.
          </span>
        </div>
      )}

      {/* Benchmark strip */}
      {baseline && (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-3.5 flex items-center gap-6 flex-wrap">
          <Stat label="Baseline" value={`${baseline.overallScore}`} grade={baseline.grade} />
          <Stat
            label="Latest simulation"
            value={activeSim ? `${activeSim.overallScore}` : "—"}
            grade={activeSim?.grade}
            accent
          />
          {benchmark && (
            <Stat label={`Best competitor · ${benchmark.name}`} value={`${benchmark.score}`} />
          )}
          <div className="flex-1 min-w-[220px]">
            <div className="h-2 rounded-full bg-slate-100 relative">
              {activeSim && (
                <div
                  className="absolute h-2 rounded-full bg-indigo-300"
                  style={{ width: `${Math.min(100, activeSim.overallScore)}%` }}
                />
              )}
              <div
                className="absolute h-2 rounded-full bg-indigo-600"
                style={{ width: `${Math.min(100, baseline.overallScore)}%` }}
              />
              {benchmark && (
                <div
                  className="absolute w-0.5 bg-red-500"
                  style={{ left: `${Math.min(100, benchmark.score)}%`, top: -4, height: 16 }}
                  title={`${benchmark.name}: ${benchmark.score}`}
                />
              )}
            </div>
            <div className="flex justify-between text-[10px] mt-1" style={{ color: "var(--text-3)" }}>
              <span>
                {baseline.overallScore}
                {activeSim ? ` → ${activeSim.overallScore} simulated` : ""}
              </span>
              {benchmark && <span className="text-red-500">▮ {benchmark.name} {benchmark.score}</span>}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[1.35fr,1fr] gap-5 items-start">
        {/* ── LEFT: editor ── */}
        <div className="space-y-4">
          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-slate-700">Content Editor</h3>
              <div className="flex gap-1 bg-slate-100 rounded-lg p-0.5">
                {(["content", "details", "diff"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    onClick={() => setTab(t)}
                    className={`px-3 py-1 rounded-md text-xs font-semibold transition-colors ${
                      tab === t ? "bg-white text-slate-900 shadow-sm" : "text-slate-500"
                    }`}
                  >
                    {t === "content" ? "Content" : t === "details" ? "Page Details" : "Diff vs Original"}
                  </button>
                ))}
              </div>
            </div>

            {tab === "content" && (
              <div className="p-4 space-y-4">
                <Field label="Page title">
                  <input
                    value={editor.title}
                    onChange={(e) => update("title", e.target.value)}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
                  />
                </Field>
                <Field
                  label="Meta description"
                  hint="Feeds Retrievable + Core Intent — the simulator scores exactly what a crawl would see."
                >
                  <textarea
                    value={editor.metaDescription}
                    onChange={(e) => update("metaDescription", e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none resize-y"
                  />
                </Field>
                <Field
                  label="Body content (markdown: ## headings, [text](url) links)"
                  hint="Headings, links and word count are derived from this text with the same formulas the crawler uses."
                >
                  <textarea
                    value={editor.bodyMd}
                    onChange={(e) => update("bodyMd", e.target.value)}
                    rows={22}
                    spellCheck={false}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px] leading-relaxed text-slate-800 font-mono focus:border-indigo-500 focus:outline-none resize-y"
                  />
                </Field>
              </div>
            )}

            {tab === "details" && (
              <div className="p-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                <Field label="Author" hint="Visible attribution improves Citable.">
                  <input
                    value={editor.metadata.author ?? ""}
                    onChange={(e) =>
                      update("metadata", { ...editor.metadata, author: e.target.value || undefined })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Canonical URL">
                  <input
                    value={editor.metadata.canonicalUrl ?? ""}
                    onChange={(e) =>
                      update("metadata", { ...editor.metadata, canonicalUrl: e.target.value || undefined })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-mono"
                  />
                </Field>
                <Field label="Published date" hint="e.g. 2026-07-01">
                  <input
                    value={editor.metadata.publishedDate ?? ""}
                    onChange={(e) =>
                      update("metadata", { ...editor.metadata, publishedDate: e.target.value || undefined })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Modified date">
                  <input
                    value={editor.metadata.modifiedDate ?? ""}
                    onChange={(e) =>
                      update("metadata", { ...editor.metadata, modifiedDate: e.target.value || undefined })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Schema.org type" hint="e.g. Article, FAQPage, HowTo">
                  <input
                    value={editor.metadata.schemaOrgType ?? ""}
                    onChange={(e) =>
                      update("metadata", { ...editor.metadata, schemaOrgType: e.target.value || undefined })
                    }
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </Field>
                <Field label="Structured data present">
                  <label className="flex items-center gap-2 text-sm text-slate-700 py-2">
                    <input
                      type="checkbox"
                      checked={editor.metadata.hasStructuredData}
                      onChange={(e) =>
                        update("metadata", { ...editor.metadata, hasStructuredData: e.target.checked })
                      }
                    />
                    Page will include JSON-LD / schema markup
                  </label>
                </Field>
                <Field label={`Internal links (${editor.internalLinks.length}) — one per line`}>
                  <textarea
                    value={editor.internalLinks.join("\n")}
                    onChange={(e) => update("internalLinks", linesToList(e.target.value))}
                    rows={6}
                    spellCheck={false}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono resize-y"
                  />
                </Field>
                <Field label={`External links (${editor.externalLinks.length}) — one per line`}>
                  <textarea
                    value={editor.externalLinks.join("\n")}
                    onChange={(e) => update("externalLinks", linesToList(e.target.value))}
                    rows={6}
                    spellCheck={false}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-xs font-mono resize-y"
                  />
                </Field>
              </div>
            )}

            {tab === "diff" && (
              <div className="p-4">
                <DiffView original={seed.bodyMd} current={editor.bodyMd} />
              </div>
            )}

            <div className="px-4 py-2.5 border-t border-slate-100 flex items-center justify-between text-[11px]" style={{ color: "var(--text-3)" }}>
              <span>
                {derived.wordCount.toLocaleString()} words · {derived.headingCount} headings · {derived.internalCount} internal / {derived.externalCount} external links
              </span>
              <span>{dirty ? "Unsaved changes" : activeDraftId ? "Saved" : "Baseline (unedited)"}</span>
            </div>
          </div>

          {/* Save draft — directly under the editor. Always enabled (unless a
              save/sim is already running) so it saves whatever is in the inputs,
              including content typed or pasted in by hand. */}
          <div className="flex items-center gap-3">
            <button
              onClick={saveDraft}
              disabled={busy !== ""}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {busy === "save" ? <Working label="Saving…" secs={busySecs} /> : "Save Draft"}
            </button>
            <span className="text-[11px]" style={{ color: "var(--text-3)" }}>
              {dirty ? "Unsaved changes" : activeDraftId ? "Draft saved" : "Baseline (unedited)"}
            </span>
          </div>

          {/* Parity note */}
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-[11.5px] leading-relaxed flex gap-2" style={{ color: "var(--text-2)" }}>
            <span className="text-emerald-600">●</span>
            <span>
              <b>Score parity:</b> Simulate runs the exact production scoring engine (model {props.scoringModel}, prompt {props.promptVersion}, temperature 0, baseline-run weights). Publish this content as written and the next real audit of this URL reproduces the simulated score. Simulations are sandboxed — they never change your audit history or competitor comparisons.
            </span>
          </div>
        </div>

        {/* ── RIGHT: scores ── */}
        <div className="space-y-4">
          {verify && (
            <div
              className={`rounded-xl border overflow-hidden ${
                verify.matched ? "border-emerald-300 bg-emerald-50/50" : "border-amber-300 bg-amber-50/50"
              }`}
            >
              <div className="px-4 py-3 flex items-start gap-2.5">
                <span className={`text-lg leading-none ${verify.matched ? "text-emerald-600" : "text-amber-600"}`}>
                  {verify.matched ? "✓" : "△"}
                </span>
                <div className="min-w-0 flex-1">
                  {verify.matched ? (
                    <>
                      <p className="text-sm font-bold text-emerald-800">
                        Published page verified — real score {verify.realOverall} ({verify.realGrade})
                      </p>
                      <p className="text-[11.5px] text-emerald-700 mt-0.5">
                        The live page&apos;s content fingerprint is identical to the simulated draft, so the
                        real score equals the simulation exactly. No re-scoring was needed.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-bold text-amber-800">
                        Published page differs from the draft — real score {verify.realOverall} (
                        {verify.realGrade}) vs simulated {verify.simulatedOverall}
                      </p>
                      {verify.fidelity && (
                        <div className="text-[11.5px] text-amber-800 mt-1 space-y-1">
                          <p>
                            Content match: {verify.fidelity.matchPct}%
                            {!verify.fidelity.titleMatch && " · title differs"}
                            {!verify.fidelity.metaMatch && " · meta description differs"}
                          </p>
                          {verify.fidelity.missingHeadings.length > 0 && (
                            <p>Draft headings not found on the page: {verify.fidelity.missingHeadings.join(" · ")}</p>
                          )}
                          {verify.fidelity.extraHeadings.length > 0 && (
                            <p>Extra headings on the page: {verify.fidelity.extraHeadings.join(" · ")}</p>
                          )}
                          {verify.fidelity.publishedNotInDraft.length > 0 && (
                            <p className="italic">
                              On the page but not in your draft: &ldquo;{verify.fidelity.publishedNotInDraft[0]}&rdquo;
                              {verify.fidelity.publishedNotInDraft.length > 1 &&
                                ` (+${verify.fidelity.publishedNotInDraft.length - 1} more)`}
                            </p>
                          )}
                          {verify.fidelity.draftNotInPublished.length > 0 && (
                            <p className="italic">
                              In your draft but not published: &ldquo;{verify.fidelity.draftNotInPublished[0]}&rdquo;
                              {verify.fidelity.draftNotInPublished.length > 1 &&
                                ` (+${verify.fidelity.draftNotInPublished.length - 1} more)`}
                            </p>
                          )}
                          <p className="text-amber-700">
                            Common cause: the CMS template injects text the editor didn&apos;t include. Update
                            the draft to match reality and re-simulate, or adjust the published page.
                          </p>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <button onClick={() => setVerify(null)} className="text-slate-400 hover:text-slate-600 text-sm leading-none">
                  ×
                </button>
              </div>
            </div>
          )}

          {activeSim && baseline && (
            <div className="rounded-xl border border-indigo-200 bg-gradient-to-b from-indigo-50/60 to-white overflow-hidden">
              <div className="px-4 py-3 border-b border-indigo-100 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">
                  Simulation — Draft v{(drafts.filter((d) => d.id === activeSim.draftId)[0]?.version) ?? "?"}
                </h3>
                <span className="text-[10px]" style={{ color: "var(--text-3)" }}>
                  {activeSim.reused ? "identical content — baseline score reused" : `scored ${activeSim.createdAt.slice(11, 16)} UTC`}
                </span>
              </div>
              <div className="px-4 py-3 flex items-center gap-3 flex-wrap">
                <span className="text-lg text-slate-400 line-through">{baseline.overallScore}</span>
                <span className="text-slate-400">→</span>
                <span className="text-3xl font-extrabold text-indigo-700">{activeSim.overallScore}</span>
                <span className={`grade-${activeSim.grade} rounded-md px-2 py-0.5 text-sm font-bold`}>
                  {activeSim.grade}
                </span>
                <DeltaPill delta={activeSim.overallScore - baseline.overallScore} />
                {benchmark && activeSim.overallScore > benchmark.score && baseline.overallScore <= benchmark.score && (
                  <span className="rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2.5 py-0.5 text-[11px] font-bold">
                    Now beats {benchmark.name} ({benchmark.score})
                  </span>
                )}
              </div>
              <div className="px-4 pb-3 grid grid-cols-2 gap-1.5">
                {ALL_DIMENSIONS.map((dim) => {
                  const b = baseline.scores[dim];
                  const s = activeSim.scores[dim];
                  const d = s - b;
                  return (
                    <div key={dim} className="flex justify-between rounded-md bg-slate-50 px-2.5 py-1 text-[11px]">
                      <span className="text-slate-500">{DIMENSION_LABELS[dim]}</span>
                      <span className={`font-bold font-mono ${d > 0 ? "text-emerald-600" : d < 0 ? "text-red-500" : "text-slate-400"}`}>
                        {b} → {s}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700">Dimension Scores &amp; Insights</h3>
              {baseline && (
                <button
                  onClick={() => rewrite(weakestDims)}
                  disabled={busy !== ""}
                  className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-500 disabled:opacity-40"
                >
                  {busy === "rewrite" ? (
                    <Working label="Writing…" secs={busySecs} />
                  ) : (
                    "✦ AI rewrite weakest 3"
                  )}
                </button>
              )}
            </div>
            {!baseline ? (
              <p className="p-4 text-xs" style={{ color: "var(--text-3)" }}>
                No completed audit found for this page yet — run an audit first.
              </p>
            ) : (
              <div>
                {ALL_DIMENSIONS.map((dim) => {
                  const score = baseline.scores[dim];
                  const simScore = activeSim ? activeSim.scores[dim] : null;
                  const open = expanded === dim;
                  const recs = baseline.recommendations.filter((r) => r.dimension === dim);
                  const group = DIMENSION_GROUPS.contentQuality.indexOf(dim) !== -1
                    ? "Content Quality"
                    : DIMENSION_GROUPS.searchVisibility.indexOf(dim) !== -1
                    ? "Search Visibility"
                    : "AI Accessibility";
                  return (
                    <div key={dim} className={`border-b border-slate-100 last:border-b-0 ${open ? "bg-indigo-50/30" : ""}`}>
                      <button
                        onClick={() => setExpanded(open ? null : dim)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                      >
                        <span className="text-slate-400 text-[10px] w-3">{open ? "▾" : "▸"}</span>
                        <span className="w-[124px] flex-shrink-0">
                          <span className="block text-[13px] font-semibold text-slate-700">{DIMENSION_LABELS[dim]}</span>
                          <span className="block text-[9.5px] text-slate-400">{group}</span>
                        </span>
                        <span className="flex-1 h-1.5 rounded-full bg-slate-100 relative overflow-hidden">
                          <span
                            className="absolute h-full rounded-full"
                            style={{ width: `${score}%`, background: scoreBg(score) }}
                          />
                        </span>
                        <span className="w-8 text-right font-mono font-bold text-sm" style={{ color: scoreColor(score) }}>
                          {score}
                        </span>
                        <span className={`w-10 text-right text-xs font-bold ${simScore == null || simScore === score ? "text-slate-300" : simScore > score ? "text-emerald-600" : "text-red-500"}`}>
                          {simScore == null || simScore === score ? "—" : simScore > score ? `+${simScore - score}` : `${simScore - score}`}
                        </span>
                      </button>
                      {open && (
                        <div className="px-4 pb-4 space-y-2.5">
                          <InsightBox label="Why this score" text={baseline.rationale[dim] ?? "No rationale stored."} />
                          {(baseline.evidence?.[dim] ?? []).map((q, i) => (
                            <InsightBox key={i} label="Evidence from your page" text={`“${q}”`} italic />
                          ))}
                          {recs.map((r, i) => (
                            <InsightBox
                              key={`r${i}`}
                              label={`Audit recommendation · ${r.priority}`}
                              text={r.suggestion + (r.example ? ` — e.g. ${r.example}` : "")}
                            />
                          ))}
                          {activeSim?.rationale?.[dim] && (
                            <InsightBox label="Simulated rationale" text={activeSim.rationale[dim]} accent />
                          )}
                          <div className="flex gap-2 flex-wrap">
                            <button
                              onClick={() => rewrite([dim])}
                              disabled={busy !== ""}
                              className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                            >
                              {busy === "rewrite" ? (
                                <Working label="Writing…" secs={busySecs} />
                              ) : (
                                `✦ AI Rewrite for ${DIMENSION_LABELS[dim]}`
                              )}
                            </button>
                            {RESEARCH_DIMS[dim] && !research[dim] && (
                              <button
                                onClick={() => fetchResearch(dim)}
                                disabled={busy !== ""}
                                className="rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 transition-colors"
                              >
                                {busy === "research" ? (
                                  <Working label="Searching the web…" secs={busySecs} />
                                ) : (
                                  RESEARCH_DIMS[dim]!.button
                                )}
                              </button>
                            )}
                          </div>

                          {RESEARCH_DIMS[dim] && research[dim] && (
                            <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-3 space-y-2">
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <p className="text-[11px] font-bold text-indigo-800">
                                  {RESEARCH_DIMS[dim]!.header} — live web research
                                </p>
                                <span className="text-[10px] text-slate-400">
                                  {research[dim]!.suggestions.length} source-backed item
                                  {research[dim]!.suggestions.length !== 1 ? "s" : ""}
                                  {research[dim]!.cached && (
                                    <>
                                      {" · cached "}
                                      <button
                                        onClick={() => fetchResearch(dim, true)}
                                        disabled={busy !== ""}
                                        className="underline text-indigo-600 disabled:opacity-50"
                                      >
                                        refresh
                                      </button>
                                    </>
                                  )}
                                </span>
                              </div>
                              {research[dim]!.suggestions.map((s, i) => (
                                <label
                                  key={i}
                                  className="flex items-start gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 cursor-pointer"
                                >
                                  <input
                                    type="checkbox"
                                    className="mt-0.5"
                                    checked={checkedSug[`${dim}:${i}`] === true}
                                    onChange={(e) =>
                                      setCheckedSug((c) => ({ ...c, [`${dim}:${i}`]: e.target.checked }))
                                    }
                                  />
                                  <span className="min-w-0">
                                    <span className="block text-xs font-semibold text-slate-800">{s.title}</span>
                                    <span className="block text-[11px] text-slate-500 mt-0.5">{s.summary}</span>
                                    <a
                                      href={s.sourceUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      onClick={(e) => e.stopPropagation()}
                                      className="block text-[10.5px] text-indigo-600 hover:underline mt-0.5 truncate"
                                    >
                                      ↗ {s.sourceTitle}
                                    </a>
                                  </span>
                                </label>
                              ))}
                              <div className="flex items-center justify-between gap-2 flex-wrap">
                                <span className="text-[10px] text-slate-400">
                                  Every suggestion carries its source. Nothing is invented.
                                </span>
                                <button
                                  onClick={() => generateCopy(dim)}
                                  disabled={
                                    busy !== "" ||
                                    research[dim]!.suggestions.filter((_, i) => checkedSug[`${dim}:${i}`])
                                      .length === 0
                                  }
                                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
                                >
                                  {busy === "generate" ? (
                                    <Working label="Writing…" secs={busySecs} />
                                  ) : (
                                    `Generate Copy from Selected (${
                                      research[dim]!.suggestions.filter(
                                        (_, i) => checkedSug[`${dim}:${i}`]
                                      ).length
                                    })`
                                  )}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Simulate — runs the production scoring engine on the current draft
              (auto-saves first). Save Draft now lives under the editor. */}
          <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <button
              onClick={simulate}
              disabled={busy !== ""}
              className="w-full rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {busy === "simulate" ? (
                <Working label="Simulating…" secs={busySecs} />
              ) : (
                "▶ Simulate Score"
              )}
            </button>
          </div>
        </div>
      </div>

      {/* AI proposal overlay */}
      {proposal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-3xl rounded-2xl border border-slate-300 bg-white flex flex-col max-h-[85vh]">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  {proposal.mode === "append"
                    ? `✦ New section from real research — ${proposal.dims.map((d) => DIMENSION_LABELS[d]).join(", ")}`
                    : `✦ AI Rewrite proposal — targeting ${proposal.dims.map((d) => DIMENSION_LABELS[d]).join(", ")}`}
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Review before accepting. Bracketed [ADD: …] placeholders mark spots that need your real data — the AI never invents facts.
                </p>
              </div>
              <button onClick={() => setProposal(null)} className="text-slate-400 hover:text-slate-700 text-xl leading-none">×</button>
            </div>
            <pre className="flex-1 overflow-y-auto px-5 py-4 text-[12.5px] leading-relaxed text-slate-800 whitespace-pre-wrap font-mono bg-slate-50">
              {proposal.markdown}
            </pre>
            <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setProposal(null)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                Discard
              </button>
              <button
                onClick={() => {
                  update(
                    "bodyMd",
                    proposal.mode === "append"
                      ? `${editor.bodyMd.replace(/\s+$/, "")}\n\n${proposal.markdown}`
                      : proposal.markdown
                  );
                  setProposal(null);
                  setTab("content");
                }}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
              >
                {proposal.mode === "append" ? "✓ Insert into content" : "✓ Replace editor content"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Small components ──────────────────────────────────────────

// Turning spinner that inherits the current text color (border-current), so it
// reads correctly on both light buttons (slate/indigo text) and filled buttons
// (white text). Used on every busy action to signal "still working".
function Spinner() {
  return (
    <span className="inline-block w-3 h-3 mr-1.5 align-[-2px] rounded-full border-2 border-current border-t-transparent animate-spin" />
  );
}

// A busy label: spinner + verb + live elapsed seconds (e.g. "Writing… 12s").
function Working({ label, secs }: { label: string; secs: number }) {
  return (
    <span className="inline-flex items-center">
      <Spinner />
      {label} {secs}s
    </span>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[10.5px] font-bold uppercase tracking-wide text-slate-500 mb-1.5">{label}</label>
      {children}
      {hint && <p className="text-[10.5px] text-slate-400 mt-1">{hint}</p>}
    </div>
  );
}

function Stat({ label, value, grade, accent }: { label: string; value: string; grade?: string; accent?: boolean }) {
  return (
    <div>
      <span className="block text-[10px] uppercase tracking-wide" style={{ color: "var(--text-3)" }}>{label}</span>
      <span className={`text-base font-bold ${accent ? "text-indigo-700" : ""}`} style={accent ? {} : { color: "var(--text-1)" }}>
        {value}
        {grade && <span className={`grade-${grade} rounded px-1.5 py-0.5 text-[10px] font-bold ml-1.5 align-[2px]`}>{grade}</span>}
      </span>
    </div>
  );
}

function InsightBox({ label, text, italic, accent }: { label: string; text: string; italic?: boolean; accent?: boolean }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${accent ? "border-indigo-200 bg-indigo-50/50" : "border-slate-100 bg-slate-50"}`}>
      <p className="text-[9.5px] font-bold uppercase tracking-wide text-slate-400 mb-0.5">{label}</p>
      <p className={`text-xs text-slate-600 ${italic ? "italic" : ""}`}>{text}</p>
    </div>
  );
}

function DeltaPill({ delta }: { delta: number }) {
  if (delta === 0) {
    return <span className="rounded-full bg-slate-100 text-slate-500 px-2.5 py-0.5 text-[11px] font-bold">no change</span>;
  }
  const up = delta > 0;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${up ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-red-50 text-red-600 border border-red-200"}`}>
      {up ? "▲" : "▼"} {up ? "+" : ""}{delta} overall
    </span>
  );
}

// ── Diff view (line-level LCS) ────────────────────────────────

function DiffView({ original, current }: { original: string; current: string }) {
  const rows = useMemo(() => lineDiff(original, current), [original, current]);
  const changed = rows.filter((r) => r.type !== "same").length;
  if (changed === 0) {
    return <p className="text-xs text-slate-400 py-6 text-center">No changes vs the original crawled content yet.</p>;
  }
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden text-[12px] font-mono leading-relaxed max-h-[480px] overflow-y-auto">
      {rows.map((r, i) =>
        r.type === "same" ? (
          <div key={i} className="px-3 py-0.5 text-slate-400 whitespace-pre-wrap">{r.text || " "}</div>
        ) : r.type === "del" ? (
          <div key={i} className="px-3 py-0.5 bg-red-50 text-red-700 whitespace-pre-wrap">− {r.text}</div>
        ) : (
          <div key={i} className="px-3 py-0.5 bg-emerald-50 text-emerald-700 whitespace-pre-wrap">+ {r.text}</div>
        )
      )}
    </div>
  );
}

interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
}

function lineDiff(a: string, b: string): DiffRow[] {
  const A = a.split("\n");
  const B = b.split("\n");
  // Guard: LCS is O(n·m); beyond this fall back to a plain replace view.
  if (A.length * B.length > 400_000) {
    const out: DiffRow[] = [];
    for (const l of A) out.push({ type: "del", text: l });
    for (const l of B) out.push({ type: "add", text: l });
    return out;
  }
  const n = A.length;
  const m = B.length;
  const dp: number[][] = [];
  for (let i = 0; i <= n; i++) dp.push(new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ type: "same", text: A[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: "del", text: A[i] });
      i++;
    } else {
      out.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: A[i++] });
  while (j < m) out.push({ type: "add", text: B[j++] });
  return out;
}

// ── Derived stats (client mirror of lib/optimize/transform.ts) ──

function deriveStats(e: EditorState, url: string) {
  let headingCount = 0;
  for (const line of e.bodyMd.split("\n")) {
    if (/^\s*#{1,6}\s+\S/.test(line)) headingCount++;
  }
  const stripped = e.bodyMd
    .split("\n")
    .map((l) => l.replace(/^\s*#{1,6}\s+/, ""))
    .join("\n")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1");
  const bodyText = stripped.replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).filter(Boolean).length : 0;

  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {}
  const internal = [...e.internalLinks];
  const external = [...e.externalLinks];
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(e.bodyMd)) !== null) {
    try {
      const resolved = new URL(m[2], url).href.split("#")[0];
      if (origin && resolved.startsWith(origin)) {
        if (internal.indexOf(resolved) === -1) internal.push(resolved);
      } else if (external.indexOf(resolved) === -1) external.push(resolved);
    } catch {}
  }

  return {
    wordCount,
    headingCount,
    internalCount: Math.min(internal.length, 100),
    externalCount: Math.min(external.length, 50),
  };
}

function draftToEditor(d: WorkbenchDraft): EditorState {
  return {
    title: d.title,
    metaDescription: d.metaDescription,
    bodyMd: d.bodyMd,
    metadata: d.metadata,
    internalLinks: d.internalLinks,
    externalLinks: d.externalLinks,
  };
}

function linesToList(v: string): string[] {
  return v
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 100);
}

function scoreColor(score: number): string {
  if (score >= 80) return "#059669";
  if (score >= 65) return "#2563eb";
  if (score >= 50) return "#d97706";
  if (score >= 35) return "#ea580c";
  return "#dc2626";
}

function scoreBg(score: number): string {
  if (score >= 80) return "#10b981";
  if (score >= 65) return "#3b82f6";
  if (score >= 50) return "#f59e0b";
  if (score >= 35) return "#f97316";
  return "#ef4444";
}
