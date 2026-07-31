"use client";

// ─────────────────────────────────────────────────────────────
//  RailRunButton — "Run Audit" pinned at the top of the project
//  rail, so a scan can be started from any section instead of
//  only from the Overview header.
//
//  Deliberately a BUTTON, not a rail link: every other rail row
//  navigates somewhere, and styling an action to look like a
//  destination is how people end up clicking it expecting a page.
//
//  On success it pushes to the Overview, because that is the only
//  surface that renders LiveAuditBanner (progress) and the
//  last-run-failure alert — starting a run from Competitors and
//  leaving the user there is the same silent no-op the run-failure
//  work fixed in July.
// ─────────────────────────────────────────────────────────────

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  projectId: string;
  /** Compact pill variant for the < lg horizontal tab bar. */
  compact?: boolean;
}

export default function RailRunButton({ projectId, compact = false }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRun() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/projects/${projectId}/run`, { method: "POST" });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        // The route returns a real, actionable message now (403 vs no sitemap),
        // so show it verbatim rather than a generic failure.
        setError(data.error ?? "Failed to start audit");
        return;
      }

      // Overview owns the live banner; go watch it there.
      router.push(`/projects/${projectId}`);
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  const icon = loading ? (
    <span className="spinner" style={{ width: 13, height: 13 }} />
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  );

  if (compact) {
    return (
      <button
        onClick={handleRun}
        disabled={loading}
        title={error || "Run a new audit"}
        className="btn-primary whitespace-nowrap flex items-center gap-1.5"
        style={{ padding: "6px 12px", fontSize: 12.5, borderRadius: 8 }}
      >
        {icon}
        {loading ? "Starting…" : "Run Audit"}
      </button>
    );
  }

  return (
    <div className="mb-2.5">
      <button
        onClick={handleRun}
        disabled={loading}
        className="btn-primary w-full flex items-center justify-center gap-2"
        style={{ padding: "9px 14px", fontSize: 13.5, fontWeight: 600 }}
      >
        {icon}
        {loading ? "Starting…" : "Run Audit"}
      </button>

      {error && (
        <div
          role="alert"
          className="mt-1.5 text-[11px] rounded-lg px-2.5 py-2"
          style={{
            color: "#b91c1c",
            background: "rgba(239,68,68,0.08)",
            border: "1px solid rgba(239,68,68,0.35)",
            lineHeight: 1.45,
          }}
        >
          {error}
        </div>
      )}
    </div>
  );
}
