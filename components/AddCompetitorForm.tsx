"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  projectId: string;
}

export default function AddCompetitorForm({ projectId }: Props) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [scopePrefix, setScopePrefix] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  function isValidUrl(u: string) {
    try { new URL(u); return true; } catch { return false; }
  }

  const canSubmit = name.trim() && isValidUrl(url) && !loading;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;

    setLoading(true);
    setError("");
    setSuccess(false);

    try {
      const res = await fetch(`/api/projects/${projectId}/competitors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          url: url.trim(),
          scopePrefix: scopePrefix.trim() || undefined,
        }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "Failed to add competitor");
        return;
      }

      setSuccess(true);
      setName("");
      setUrl("");
      setScopePrefix("");
      router.refresh();
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-3)" }}>
          Competitor name
        </label>
        <input
          className="dark-input"
          placeholder="Acme Competitor"
          value={name}
          onChange={e => { setName(e.target.value); setSuccess(false); }}
        />
      </div>

      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-3)" }}>
          Website URL
        </label>
        <input
          type="url"
          className="dark-input"
          placeholder="https://competitor.com"
          value={url}
          onChange={e => { setUrl(e.target.value); setSuccess(false); }}
        />
      </div>

      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: "var(--text-3)" }}>
          Scope prefix <span style={{ color: "var(--text-3)", fontWeight: 400 }}>(optional)</span>
        </label>
        <input
          className="dark-input"
          placeholder="/docs"
          value={scopePrefix}
          onChange={e => setScopePrefix(e.target.value)}
        />
      </div>

      {error && (
        <div className="rounded-lg px-3 py-2 text-xs"
          style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#dc2626" }}>
          {error}
        </div>
      )}

      {success && (
        <div className="rounded-lg px-3 py-2 text-xs anim-fade-in"
          style={{ background: "rgba(52,211,153,0.08)", border: "1px solid rgba(52,211,153,0.2)", color: "#059669" }}>
          Competitor added — run an audit to score them.
        </div>
      )}

      <button
        type="submit"
        disabled={!canSubmit}
        className="btn-primary w-full text-sm"
      >
        {loading ? (
          <span className="flex items-center justify-center gap-2">
            <span className="spinner" style={{ width: 13, height: 13 }} />
            Adding…
          </span>
        ) : (
          "+ Add competitor"
        )}
      </button>

      <p className="text-xs" style={{ color: "var(--text-3)" }}>
        Competitor audits are capped at 50 pages per run.
      </p>
    </form>
  );
}
