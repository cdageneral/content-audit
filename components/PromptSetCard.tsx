"use client";

// ─────────────────────────────────────────────────────────────
//  LLM Prompt Set card (hub) — manage the project's buyer-intent
//  prompts and run per-engine checks (ChatGPT / Claude / Gemini /
//  Perplexity via DataForSEO LLM Responses).
//
//  Every chip reflects a REAL stored check: Cited (the engine's
//  answer linked the client's site), Brand (name appeared in the
//  answer text, no link), Absent, or Error. No prompt-volume
//  figures anywhere — all vendor prompt-volume numbers are modeled
//  and are excluded by design. Costs shown are the provider's real
//  charges summed from the last run.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { useRouter } from "next/navigation";

// Client-safe mirrors of lib/db/prompts types (type-only shapes).
export type PromptEngineView = "chat_gpt" | "claude" | "gemini" | "perplexity";
export const ENGINE_ORDER: PromptEngineView[] = [
  "chat_gpt",
  "perplexity",
  "gemini",
  "claude",
];
const ENGINE_NAMES: Record<PromptEngineView, string> = {
  chat_gpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

export interface PromptCheckView {
  status: "ok" | "error";
  cited: boolean;
  citedUrl: string | null;
  brandMentioned: boolean;
  checkedAt: string;
  modelName: string;
  error: string | null;
}

export interface PromptRowView {
  id: string;
  prompt: string;
  targetUrl: string | null;
  checks: Partial<Record<PromptEngineView, PromptCheckView>>;
}

export interface LastRunView {
  at: string;
  costUsd: number;
  checks: number;
  errors: number;
}

export default function PromptSetCard({
  projectId,
  initialPrompts,
  lastRun,
  pageUrls,
  configured,
}: {
  projectId: string;
  initialPrompts: PromptRowView[];
  lastRun: LastRunView | null;
  pageUrls: string[];
  configured: boolean;
}) {
  const router = useRouter();
  const [rows, setRows] = useState<PromptRowView[]>(initialPrompts);
  const [run, setRun] = useState<LastRunView | null>(lastRun);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<"" | "add" | "run">("");
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState(initialPrompts.length > 0);

  async function addPrompts() {
    const texts = draft
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (texts.length === 0) return;
    setBusy("add");
    setMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/prompts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ add: texts }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setRows(data.prompts as PromptRowView[]);
      setDraft("");
      if (data.skipped > 0) setMsg(`${data.added} added · ${data.skipped} skipped (duplicate or over the 50-prompt cap).`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Add failed");
    } finally {
      setBusy("");
    }
  }

  async function removePrompt(promptId: string) {
    setRows((r) => r.filter((x) => x.id !== promptId));
    await fetch(`/api/projects/${projectId}/prompts?promptId=${promptId}`, {
      method: "DELETE",
    }).catch(() => undefined);
  }

  async function assign(promptId: string, targetUrl: string) {
    setRows((r) =>
      r.map((x) => (x.id === promptId ? { ...x, targetUrl: targetUrl || null } : x))
    );
    await fetch(`/api/projects/${projectId}/prompts`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ promptId, targetUrl: targetUrl || null }),
    }).catch(() => undefined);
  }

  async function runChecks() {
    setBusy("run");
    setMsg(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/prompts/check`, {
        method: "POST",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
      setMsg(
        `Running ${data.checks} checks (${data.prompts} prompts × ${data.engines.length} engines) against the live engines — results and the exact provider cost appear here in a few minutes.`
      );
      // Poll a few times for fresh rows, then hand back to the server page.
      let polls = 0;
      const iv = setInterval(async () => {
        polls++;
        try {
          const r = await fetch(`/api/projects/${projectId}/prompts`);
          const d = await r.json();
          if (r.ok) {
            setRows(d.prompts as PromptRowView[]);
            if (d.lastRun) setRun(d.lastRun as LastRunView);
          }
        } catch {
          /* keep polling */
        }
        if (polls >= 24) {
          clearInterval(iv);
          router.refresh();
        }
      }, 10_000);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : "Run failed");
    } finally {
      setBusy("");
    }
  }

  function pagePath(u: string): string {
    try {
      const p = new URL(u);
      return p.pathname === "/" ? p.hostname : p.pathname;
    } catch {
      return u;
    }
  }

  return (
    <div className="anim-fade-up card p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-base font-semibold" style={{ color: "var(--text-1)" }}>
            LLM Prompt Set — ChatGPT, Perplexity, Gemini &amp; Claude
          </h2>
          <p className="text-xs mt-0.5" style={{ color: "var(--text-3)" }}>
            Buyer-intent prompts checked against the real engines: is your site cited, named, or
            absent in the answer? Verified checks only — no prompt-volume estimates exist that
            aren&apos;t modeled, so none are shown.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {rows.length > 0 && configured && (
            <button
              onClick={runChecks}
              disabled={busy !== ""}
              className="rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors"
            >
              {busy === "run"
                ? "Dispatching…"
                : `▶ Run checks (${rows.length} × ${ENGINE_ORDER.length})`}
            </button>
          )}
          <button
            onClick={() => setOpen((o) => !o)}
            className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-500"
          >
            {open ? "Hide ▴" : `Manage (${rows.length}) ▾`}
          </button>
        </div>
      </div>

      {msg && (
        <p className="mt-3 text-xs rounded-lg border border-indigo-200 bg-indigo-50/60 px-3 py-2 text-indigo-800">
          {msg}
        </p>
      )}

      {open && (
        <div className="mt-4 space-y-4">
          {/* Add prompts */}
          <div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={3}
              placeholder={
                "One prompt per line, phrased the way a buyer would ask an AI assistant.\ne.g. What do I need to qualify for a personal loan?"
              }
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs text-slate-800 focus:border-indigo-500 focus:outline-none resize-y"
            />
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-[10.5px]" style={{ color: "var(--text-3)" }}>
                {rows.length}/50 prompts · each check is a paid live call; real cost is reported
                after every run
              </span>
              <button
                onClick={addPrompts}
                disabled={busy !== "" || !draft.trim()}
                className="rounded-lg border border-indigo-300 bg-white px-3 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-50 disabled:opacity-50 transition-colors"
              >
                {busy === "add" ? "Adding…" : "+ Add prompts"}
              </button>
            </div>
          </div>

          {/* Prompt rows */}
          {rows.length === 0 ? (
            <p className="text-xs py-2" style={{ color: "var(--text-3)" }}>
              No prompts yet. Add the questions your buyers actually ask an AI assistant — then
              run checks to see who gets cited.
            </p>
          ) : (
            <div className="rounded-xl border border-slate-200 overflow-hidden">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="px-3.5 py-2.5 border-b border-slate-100 last:border-b-0 bg-white"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-xs font-semibold text-slate-800 min-w-0">
                      &ldquo;{r.prompt}&rdquo;
                    </p>
                    <button
                      onClick={() => removePrompt(r.id)}
                      title="Remove prompt"
                      className="text-slate-300 hover:text-red-500 text-sm leading-none flex-none"
                    >
                      ×
                    </button>
                  </div>
                  <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                    {ENGINE_ORDER.map((e) => {
                      const c = r.checks[e];
                      const cls = !c
                        ? "border-slate-200 bg-slate-50 text-slate-400"
                        : c.status === "error"
                        ? "border-slate-200 bg-slate-50 text-slate-400"
                        : c.cited
                        ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                        : c.brandMentioned
                        ? "border-amber-200 bg-amber-50 text-amber-800"
                        : "border-red-200 bg-red-50 text-red-600";
                      const label = !c
                        ? "—"
                        : c.status === "error"
                        ? "error"
                        : c.cited
                        ? "✓ cited"
                        : c.brandMentioned
                        ? "brand"
                        : "absent";
                      const title = !c
                        ? "Not checked yet"
                        : c.status === "error"
                        ? c.error ?? "Check failed"
                        : c.cited
                        ? `Answer cites ${c.citedUrl ?? "your site"} (${c.modelName})`
                        : c.brandMentioned
                        ? `Brand named in the answer, no link (${c.modelName})`
                        : `Not in the answer (${c.modelName})`;
                      return (
                        <span
                          key={e}
                          title={title}
                          className={`rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cls}`}
                        >
                          {ENGINE_NAMES[e]} · {label}
                        </span>
                      );
                    })}
                    <select
                      value={r.targetUrl ?? ""}
                      onChange={(e) => assign(r.id, e.target.value)}
                      title="Assign this prompt to a page so it appears in that page's Optimize workbench"
                      className="ml-auto rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-500 max-w-[220px]"
                    >
                      <option value="">page: auto (cited URL)</option>
                      {pageUrls.map((u) => (
                        <option key={u} value={u}>
                          {pagePath(u)}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Footer: last-run truth */}
          <p className="text-[10.5px]" style={{ color: "var(--text-3)" }}>
            {run
              ? `Last run ${run.at.slice(0, 16).replace("T", " ")} UTC · ${run.checks} checks${
                  run.errors ? ` (${run.errors} errors)` : ""
                } · provider cost $${run.costUsd.toFixed(4)} (real charge from DataForSEO)`
              : "No checks run yet."}
            {!configured && " · Checks unavailable: DataForSEO credentials not configured."}
          </p>
        </div>
      )}
    </div>
  );
}
