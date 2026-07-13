"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  projectId: string;
  hasCompetitors: boolean;
}

export default function RunButton({ projectId, hasCompetitors }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleRun() {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/projects/${projectId}/run`, {
        method: "POST",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error ?? "Failed to start audit");
        return;
      }

      // Refresh the page so the active banner shows
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <button
        onClick={handleRun}
        disabled={loading}
        className="btn-primary flex items-center gap-2"
        style={{ minWidth: 140 }}
      >
        {loading ? (
          <>
            <span className="spinner" style={{ width: 14, height: 14 }} />
            Starting…
          </>
        ) : (
          <>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            {hasCompetitors ? "Run All" : "Run Audit"}
          </>
        )}
      </button>

      {hasCompetitors && !loading && (
        <span className="text-xs" style={{ color: "var(--text-3)" }}>
          Audits client + all competitors
        </span>
      )}

      {error && (
        <span className="text-xs" style={{ color: "#dc2626" }}>{error}</span>
      )}
    </div>
  );
}
