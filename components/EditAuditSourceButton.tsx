"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";

type AuditSource = "domain" | "single" | "list";

interface Props {
  projectId: string;
  auditSource: AuditSource;
  websiteUrl: string;
  scopePrefix: string | null;
  maxPages: number;
  sourceUrls: string[] | null;
  /** URLs from the latest completed client run — used to pre-fill the list
   *  editor when switching a domain/single project to list mode. */
  latestRunUrls: string[];
}

const SOURCE_LABELS: Record<AuditSource, string> = {
  domain: "Whole domain",
  single: "Single URL",
  list: "URL list",
};

const SOURCE_HINTS: Record<AuditSource, string> = {
  domain: "Crawl and discover every page on the site (via sitemap, then links).",
  single: "Audit just one specific page — no crawling.",
  list: "Audit an exact set of URLs — paste them or upload a .txt / .csv.",
};

/** Same parsing rules as the New Project flow: one URL per line, CSV first
 *  column, dedupe, keep only http(s). */
function parseUrlList(text: string): { valid: string[]; invalidCount: number } {
  const seen = new Set<string>();
  const valid: string[] = [];
  let invalidCount = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const cell = rawLine.split(",")[0].trim().replace(/^["']|["']$/g, "");
    if (!cell) continue;
    try {
      const u = new URL(cell);
      if (u.protocol !== "http:" && u.protocol !== "https:") { invalidCount++; continue; }
      if (seen.has(u.href)) continue;
      seen.add(u.href);
      valid.push(u.href);
    } catch {
      invalidCount++;
    }
  }
  return { valid, invalidCount };
}

export default function EditAuditSourceButton(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Editor state, seeded from the project's current configuration each time
  // the modal opens (see openModal).
  const [source, setSource] = useState<AuditSource>(props.auditSource);
  const [websiteUrl, setWebsiteUrl] = useState(props.websiteUrl);
  const [scopePrefix, setScopePrefix] = useState(props.scopePrefix ?? "");
  const [maxPages, setMaxPages] = useState(props.maxPages);
  const [urlListText, setUrlListText] = useState("");
  const [fileName, setFileName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const { valid: parsedUrls, invalidCount } = parseUrlList(urlListText);

  function openModal() {
    setSource(props.auditSource);
    setWebsiteUrl(props.websiteUrl);
    setScopePrefix(props.scopePrefix ?? "");
    setMaxPages(props.auditSource === "domain" ? props.maxPages : 100);
    setUrlListText((props.sourceUrls ?? []).join("\n"));
    setFileName("");
    setError("");
    setOpen(true);
  }

  function switchSource(s: AuditSource) {
    setSource(s);
    // Pre-fill the list editor so switching to 'list' means editing the URLs
    // you already audit, not starting from scratch: saved list first, then
    // the pages of the latest completed run.
    if (s === "list" && !urlListText.trim()) {
      const seed = props.sourceUrls?.length ? props.sourceUrls : props.latestRunUrls;
      if (seed.length) setUrlListText(seed.join("\n"));
    }
  }

  function isValidUrl(u: string) {
    try {
      const p = new URL(u);
      return p.protocol === "http:" || p.protocol === "https:";
    } catch { return false; }
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      setUrlListText(prev => (prev.trim() ? prev.replace(/\s*$/, "") + "\n" + text : text));
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  const canSave =
    source === "list" ? parsedUrls.length > 0 : isValidUrl(websiteUrl);

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/projects/${props.projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          source === "list"
            ? { auditSource: source, sourceUrls: parsedUrls }
            : source === "single"
            ? { auditSource: source, websiteUrl }
            : { auditSource: source, websiteUrl, scopePrefix: scopePrefix || undefined, maxPages }
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to save changes");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <button
        onClick={openModal}
        className="btn-ghost flex items-center gap-1.5"
        style={{ fontSize: 12, padding: "4px 10px" }}
        title="Change what this project audits — add or edit URLs, or switch to a whole-domain scan"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
          <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
        </svg>
        Edit URLs
      </button>

      {/* Portal to <body>: the hub header animates with a CSS transform, and a
          transformed ancestor re-anchors position:fixed — rendered in place,
          the overlay would center on the header instead of the viewport. */}
      {open && typeof document !== "undefined" && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "rgba(15,23,42,0.55)" }}
          onClick={() => !saving && setOpen(false)}
        >
          <div
            className="card w-full max-w-xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
              <p className="text-sm font-semibold" style={{ color: "var(--text-1)" }}>
                Edit audit source
              </p>
              <button
                onClick={() => setOpen(false)}
                disabled={saving}
                className="text-xs px-2 py-1 rounded-md"
                style={{ color: "var(--text-3)", background: "var(--bg-2)", border: "1px solid var(--border)", cursor: "pointer" }}
              >
                ✕
              </button>
            </div>

            <div className="p-5 space-y-4">
              {/* Mode selector */}
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                  Audit source
                </label>
                <div className="flex gap-2 flex-wrap">
                  {(["domain", "single", "list"] as AuditSource[]).map(s => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => switchSource(s)}
                      className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                      style={{
                        background: source === s ? "rgba(99,102,241,0.2)" : "var(--bg-2)",
                        color: source === s ? "#4f46e5" : "var(--text-2)",
                        border: `1px solid ${source === s ? "rgba(99,102,241,0.4)" : "var(--border)"}`,
                      }}
                    >
                      {SOURCE_LABELS[s]}
                    </button>
                  ))}
                </div>
                <p className="text-xs mt-2" style={{ color: "var(--text-3)" }}>
                  {SOURCE_HINTS[source]}
                </p>
              </div>

              {/* Domain + single: URL field */}
              {source !== "list" && (
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                    {source === "single" ? "Page URL" : "Website URL"}
                  </label>
                  <input
                    type="url"
                    className="dark-input"
                    placeholder={source === "single" ? "https://example.com/blog/my-post" : "https://docs.example.com"}
                    value={websiteUrl}
                    onChange={e => setWebsiteUrl(e.target.value)}
                  />
                </div>
              )}

              {/* Domain only: scope + max pages */}
              {source === "domain" && (
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                      Scope prefix <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional)</span>
                    </label>
                    <input
                      className="dark-input"
                      placeholder="/docs"
                      value={scopePrefix}
                      onChange={e => setScopePrefix(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                      Max pages per run
                    </label>
                    <input
                      type="number"
                      className="dark-input"
                      value={maxPages}
                      min={1}
                      max={5000}
                      onChange={e => setMaxPages(Number(e.target.value))}
                    />
                  </div>
                </div>
              )}

              {/* List: paste + upload */}
              {source === "list" && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                      URLs <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(one per line — add, edit or remove)</span>
                    </label>
                    <textarea
                      className="dark-input font-mono text-xs"
                      rows={9}
                      placeholder={"https://example.com/page-1\nhttps://example.com/page-2\nhttps://example.com/blog/post"}
                      value={urlListText}
                      onChange={e => setUrlListText(e.target.value)}
                      style={{ resize: "vertical" }}
                    />
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <label className="btn-ghost text-sm cursor-pointer" style={{ color: "var(--indigo)" }}>
                      Upload .txt / .csv
                      <input
                        type="file"
                        accept=".txt,.csv,text/plain,text/csv"
                        onChange={handleFile}
                        style={{ display: "none" }}
                      />
                    </label>
                    {fileName && (
                      <span className="text-xs font-mono truncate" style={{ color: "var(--text-3)" }}>
                        {fileName}
                      </span>
                    )}
                    <span className="text-xs ml-auto" style={{ color: parsedUrls.length ? "var(--indigo)" : "var(--text-3)" }}>
                      {parsedUrls.length} valid URL{parsedUrls.length !== 1 ? "s" : ""}
                      {invalidCount > 0 && (
                        <span style={{ color: "#d97706" }}> · {invalidCount} skipped</span>
                      )}
                    </span>
                  </div>
                </div>
              )}

              {/* What happens next */}
              <div className="rounded-xl p-3" style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)" }}>
                <p className="text-xs leading-relaxed" style={{ color: "var(--text-2)" }}>
                  Changes apply to the <span style={{ color: "#4f46e5", fontWeight: 500 }}>next audit run</span> —
                  nothing runs now, and past results and trend history are kept as they were.
                  Pages removed here simply won't appear in future runs.
                </p>
              </div>

              {error && (
                <div className="rounded-xl p-3 text-sm" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#dc2626" }}>
                  {error}
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <button onClick={() => setOpen(false)} disabled={saving} className="btn-ghost">
                  Cancel
                </button>
                <button onClick={handleSave} disabled={!canSave || saving} className="btn-primary px-6">
                  {saving ? "Saving…" : "Save changes"}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
