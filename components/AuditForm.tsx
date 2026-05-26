"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type AuthType = "none" | "cookie" | "bearer" | "basic";

export default function AuditForm() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [scopePrefix, setScopePrefix] = useState("");
  const [maxPages, setMaxPages] = useState(100);
  const [authType, setAuthType] = useState<AuthType>("none");
  const [cookie, setCookie] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");

    const auth =
      authType === "cookie"
        ? { type: authType, cookie }
        : authType === "bearer"
        ? { type: authType, token }
        : authType === "basic"
        ? { type: authType, username, password }
        : { type: "none" as const };

    try {
      const res = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          scopePrefix: scopePrefix || undefined,
          maxPages,
          auth: authType !== "none" ? auth : undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error ?? "Something went wrong");
        return;
      }

      router.push(`/audit/${data.jobId}`);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-2xl border border-slate-800 bg-[#161b27] p-6 space-y-5"
    >
      <h2 className="text-lg font-semibold text-white">Start a New Audit</h2>

      {/* URL */}
      <div className="space-y-1.5">
        <label className="text-sm font-medium text-slate-300">Website URL</label>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://docs.example.com"
          required
          className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
        />
      </div>

      {/* Scope + max pages */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-300">
            Scope Prefix <span className="text-slate-500">(optional)</span>
          </label>
          <input
            type="text"
            value={scopePrefix}
            onChange={(e) => setScopePrefix(e.target.value)}
            placeholder="/docs/api"
            className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
        <div className="space-y-1.5">
          <label className="text-sm font-medium text-slate-300">Max Pages</label>
          <input
            type="number"
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            min={1}
            max={5000}
            className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
          />
        </div>
      </div>

      {/* Auth */}
      <div className="space-y-3">
        <label className="text-sm font-medium text-slate-300">Authentication</label>
        <div className="flex gap-2 flex-wrap">
          {(["none", "cookie", "bearer", "basic"] as AuthType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setAuthType(t)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                authType === t
                  ? "bg-indigo-600 text-white"
                  : "bg-[#0f1117] text-slate-400 border border-slate-700 hover:border-slate-500"
              }`}
            >
              {t === "none" ? "No Auth" : t === "cookie" ? "Cookie" : t === "bearer" ? "Bearer Token" : "Basic Auth"}
            </button>
          ))}
        </div>

        {authType === "cookie" && (
          <input
            type="text"
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder='session=abc123; csrf=xyz'
            className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none font-mono text-sm"
          />
        )}
        {authType === "bearer" && (
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Bearer token"
            className="w-full rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none font-mono text-sm"
          />
        )}
        {authType === "basic" && (
          <div className="grid grid-cols-2 gap-3">
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="Username"
              className="rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              className="rounded-lg border border-slate-700 bg-[#0f1117] px-3 py-2 text-white placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-red-950/30 border border-red-800/50 text-red-400 px-3 py-2 text-sm">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading || !url}
        className="w-full rounded-xl bg-indigo-600 py-3 text-sm font-semibold text-white transition-all hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Discovering URLs…" : "Start Audit"}
      </button>
    </form>
  );
}
