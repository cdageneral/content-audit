"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type AuthType = "none" | "cookie" | "bearer" | "basic";

interface CompetitorInput {
  name: string;
  url: string;
  scopePrefix: string;
}

type Step = "details" | "auth" | "competitors" | "review";

const STEPS: Step[] = ["details", "auth", "competitors", "review"];
const STEP_LABELS: Record<Step, string> = {
  details:     "1. Client details",
  auth:        "2. Authentication",
  competitors: "3. Competitors",
  review:      "4. Review & create",
};

export default function CreateProjectForm() {
  const router = useRouter();

  // Step state
  const [step, setStep] = useState<Step>("details");

  // Form fields
  const [clientName, setClientName] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [scopePrefix, setScopePrefix] = useState("");
  const [maxPages, setMaxPages] = useState(100);
  const [authType, setAuthType] = useState<AuthType>("none");
  const [cookie, setCookie] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [competitors, setCompetitors] = useState<CompetitorInput[]>([]);
  const [newComp, setNewComp] = useState<CompetitorInput>({ name: "", url: "", scopePrefix: "" });

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // ── Validation per step ─────────────────────────────────────
  function canAdvance(): boolean {
    if (step === "details") return !!clientName.trim() && isValidUrl(websiteUrl);
    return true;
  }

  function isValidUrl(u: string) {
    try { new URL(u); return true; } catch { return false; }
  }

  function advance() {
    const idx = STEPS.indexOf(step);
    if (idx < STEPS.length - 1) setStep(STEPS[idx + 1]);
  }

  function back() {
    const idx = STEPS.indexOf(step);
    if (idx > 0) setStep(STEPS[idx - 1]);
  }

  function addCompetitor() {
    if (!newComp.name.trim() || !isValidUrl(newComp.url)) return;
    setCompetitors(prev => [...prev, { ...newComp }]);
    setNewComp({ name: "", url: "", scopePrefix: "" });
  }

  function removeCompetitor(i: number) {
    setCompetitors(prev => prev.filter((_, idx) => idx !== i));
  }

  // ── Submit ──────────────────────────────────────────────────
  async function handleSubmit() {
    setLoading(true);
    setError("");

    const authConfig = authType === "cookie" ? { type: authType, cookie }
      : authType === "bearer" ? { type: authType, token }
      : authType === "basic"  ? { type: authType, username, password }
      : undefined;

    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          websiteUrl,
          scopePrefix: scopePrefix || undefined,
          maxPages,
          authConfig,
          competitors: competitors.map(c => ({
            name: c.name,
            url: c.url,
            scopePrefix: c.scopePrefix || undefined,
          })),
        }),
      });

      const data = await res.json();
      if (!res.ok) { setError(data.error ?? "Something went wrong"); return; }
      router.push(`/projects/${data.project.id}`);
    } catch {
      setError("Network error — please try again");
    } finally {
      setLoading(false);
    }
  }

  // ── Step indicator ──────────────────────────────────────────
  const stepIdx = STEPS.indexOf(step);

  return (
    <div className="card anim-fade-up">
      {/* Step nav */}
      <div className="flex border-b" style={{ borderColor: "var(--border)" }}>
        {STEPS.map((s, i) => (
          <button
            key={s}
            onClick={() => i < stepIdx ? setStep(s) : undefined}
            className="flex-1 px-4 py-3 text-xs font-medium transition-colors"
            style={{
              color: s === step ? "var(--text-1)" : i < stepIdx ? "var(--indigo)" : "var(--text-3)",
              borderTop: "none",
              borderLeft: "none",
              borderRight: "none",
              borderBottom: s === step ? "2px solid var(--indigo)" : "2px solid transparent",
              marginBottom: "-1px",
              background: "none",
              cursor: i < stepIdx ? "pointer" : "default",
            }}
          >
            {STEP_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="p-6 space-y-5">
        {/* ── Step 1: Details ─────────────────────────────── */}
        {step === "details" && (
          <>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                Client name
              </label>
              <input
                className="dark-input"
                placeholder="Acme Inc."
                value={clientName}
                onChange={e => setClientName(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>
                Website URL
              </label>
              <input
                type="url"
                className="dark-input"
                placeholder="https://docs.example.com"
                value={websiteUrl}
                onChange={e => setWebsiteUrl(e.target.value)}
              />
            </div>
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
          </>
        )}

        {/* ── Step 2: Auth ─────────────────────────────────── */}
        {step === "auth" && (
          <>
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              If the site requires authentication, configure credentials here. They're stored encrypted and never shared.
            </p>
            <div>
              <label className="block text-sm font-medium mb-3" style={{ color: "var(--text-2)" }}>
                Auth type
              </label>
              <div className="flex gap-2 flex-wrap">
                {(["none","cookie","bearer","basic"] as AuthType[]).map(t => (
                  <button
                    key={t}
                    onClick={() => setAuthType(t)}
                    className="px-4 py-2 rounded-lg text-sm font-medium transition-all"
                    style={{
                      background: authType === t ? "rgba(99,102,241,0.2)" : "var(--bg-2)",
                      color: authType === t ? "#818cf8" : "var(--text-2)",
                      border: `1px solid ${authType === t ? "rgba(99,102,241,0.4)" : "var(--border)"}`,
                    }}
                  >
                    {t === "none" ? "No auth" : t === "cookie" ? "Cookie" : t === "bearer" ? "Bearer token" : "Basic auth"}
                  </button>
                ))}
              </div>
            </div>
            {authType === "cookie" && (
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>Cookie string</label>
                <input className="dark-input font-mono text-xs" placeholder='session=abc123; csrf=xyz' value={cookie} onChange={e => setCookie(e.target.value)} />
              </div>
            )}
            {authType === "bearer" && (
              <div>
                <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>Bearer token</label>
                <input type="password" className="dark-input font-mono text-xs" placeholder="Token" value={token} onChange={e => setToken(e.target.value)} />
              </div>
            )}
            {authType === "basic" && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>Username</label>
                  <input className="dark-input" value={username} onChange={e => setUsername(e.target.value)} />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2" style={{ color: "var(--text-2)" }}>Password</label>
                  <input type="password" className="dark-input" value={password} onChange={e => setPassword(e.target.value)} />
                </div>
              </div>
            )}
          </>
        )}

        {/* ── Step 3: Competitors ───────────────────────────── */}
        {step === "competitors" && (
          <>
            <p className="text-sm" style={{ color: "var(--text-2)" }}>
              Add competitor sites to audit alongside your client. You can add up to 5 competitors and track their scores over time.
            </p>

            {/* Competitor list */}
            {competitors.length > 0 && (
              <div className="space-y-2">
                {competitors.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 rounded-xl"
                    style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
                    <div className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                      style={{ background: ["#f87171","#fb923c","#facc15","#4ade80","#38bdf8"][i] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium" style={{ color: "var(--text-1)" }}>{c.name}</p>
                      <p className="text-xs font-mono truncate" style={{ color: "var(--text-3)" }}>{c.url}</p>
                    </div>
                    <button onClick={() => removeCompetitor(i)} className="text-xs px-2 py-1 rounded"
                      style={{ color: "var(--text-3)", background: "var(--bg-3)" }}>
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Add competitor input */}
            {competitors.length < 5 && (
              <div className="rounded-xl p-4 space-y-3" style={{ background: "var(--bg-2)", border: "1px solid var(--border)" }}>
                <p className="text-sm font-medium" style={{ color: "var(--text-2)" }}>Add competitor</p>
                <input className="dark-input" placeholder="Competitor name" value={newComp.name} onChange={e => setNewComp(p => ({ ...p, name: e.target.value }))} />
                <input type="url" className="dark-input" placeholder="https://competitor.com" value={newComp.url} onChange={e => setNewComp(p => ({ ...p, url: e.target.value }))} />
                <input className="dark-input" placeholder="Scope prefix (optional)" value={newComp.scopePrefix} onChange={e => setNewComp(p => ({ ...p, scopePrefix: e.target.value }))} />
                <button
                  onClick={addCompetitor}
                  disabled={!newComp.name.trim() || !isValidUrl(newComp.url)}
                  className="btn-ghost w-full text-sm"
                  style={{ color: isValidUrl(newComp.url) && newComp.name.trim() ? "var(--indigo)" : undefined }}>
                  + Add competitor
                </button>
              </div>
            )}

            <p className="text-xs" style={{ color: "var(--text-3)" }}>
              You can also add competitors later from the project hub. Competitor audits are capped at 50 pages.
            </p>
          </>
        )}

        {/* ── Step 4: Review ────────────────────────────────── */}
        {step === "review" && (
          <>
            <ReviewRow label="Client" value={clientName} />
            <ReviewRow label="Website" value={websiteUrl} mono />
            {scopePrefix && <ReviewRow label="Scope" value={scopePrefix} mono />}
            <ReviewRow label="Max pages" value={String(maxPages)} />
            <ReviewRow label="Auth" value={authType === "none" ? "None" : authType} />
            <ReviewRow label="Competitors" value={competitors.length === 0 ? "None added" : competitors.map(c => c.name).join(", ")} />
            <div className="rounded-xl p-4 mt-2" style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.15)" }}>
              <p className="text-sm" style={{ color: "var(--text-2)" }}>
                <span style={{ color: "#818cf8", fontWeight: 500 }}>First run will start immediately</span> after you create the project —
                your site{competitors.length > 0 ? ` and ${competitors.length} competitor${competitors.length !== 1 ? "s" : ""}` : ""} will be crawled and scored.
              </p>
            </div>
          </>
        )}

        {/* Error */}
        {error && (
          <div className="rounded-xl p-3 text-sm" style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
            {error}
          </div>
        )}

        {/* Navigation */}
        <div className="flex justify-between pt-2">
          {stepIdx > 0 ? (
            <button onClick={back} className="btn-ghost">← Back</button>
          ) : <div />}

          {step !== "review" ? (
            <button onClick={advance} disabled={!canAdvance()} className="btn-primary">
              Continue →
            </button>
          ) : (
            <button onClick={handleSubmit} disabled={loading} className="btn-primary px-8">
              {loading ? "Creating…" : "Create project & run first audit →"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ReviewRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-4 items-start py-2" style={{ borderBottom: "1px solid var(--border)" }}>
      <span className="text-sm w-28 flex-shrink-0" style={{ color: "var(--text-3)" }}>{label}</span>
      <span className={`text-sm ${mono ? "font-mono" : ""}`} style={{ color: "var(--text-1)" }}>{value}</span>
    </div>
  );
}
