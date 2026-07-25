// ─────────────────────────────────────────────────────────────
//  DataForSEO AI Optimization — LLM Responses client.
//
//  Sends a buyer-intent prompt to a real consumer LLM (ChatGPT /
//  Claude / Gemini / Perplexity) through DataForSEO's live
//  llm_responses endpoints and returns the REAL answer text plus its
//  citation annotations. Costs are what DataForSEO actually charged
//  (envelope `cost`, which includes the underlying LLM charge).
//
//  Model choice: env override (LLM_MODEL_CHAT_GPT etc.) or automatic
//  discovery from the engine's /models endpoint with a preference
//  list — never a hardcoded guess that can go stale and 40xxx.
// ─────────────────────────────────────────────────────────────

import type { PromptEngine, PromptCitation } from "@/lib/db/prompts";

const API_BASE = "https://api.dataforseo.com/v3";
const FETCH_TIMEOUT_MS = 115_000; // live mode: DataForSEO allows up to ~120s

export function dfsLlmConfigured(): boolean {
  return !!process.env.DATAFORSEO_LOGIN && !!process.env.DATAFORSEO_PASSWORD;
}

function authHeader(): string {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DATAFORSEO credentials not set");
  return `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
}

// ── Model discovery ───────────────────────────────────────────

// Preference order per engine: cheap, current "mini/flash" tiers first.
// Matched against the engine's live /models list, so an entry that no longer
// exists simply falls through to the next preference.
const MODEL_PREFS: Record<PromptEngine, RegExp[]> = {
  chat_gpt: [/^gpt-5.*mini/i, /^gpt-4\.1-mini$/i, /mini/i],
  claude: [/haiku/i, /sonnet/i],
  gemini: [/^gemini-2\.5-flash$/i, /flash/i],
  perplexity: [/^sonar$/i, /sonar/i],
};

const ENV_OVERRIDES: Record<PromptEngine, string> = {
  chat_gpt: "LLM_MODEL_CHAT_GPT",
  claude: "LLM_MODEL_CLAUDE",
  gemini: "LLM_MODEL_GEMINI",
  perplexity: "LLM_MODEL_PERPLEXITY",
};

const modelCache = new Map<PromptEngine, string>();

async function pickModel(engine: PromptEngine): Promise<string> {
  const override = process.env[ENV_OVERRIDES[engine]];
  if (override) return override;
  const cached = modelCache.get(engine);
  if (cached) return cached;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(`${API_BASE}/ai_optimization/${engine}/llm_responses/models`, {
      method: "GET",
      signal: ctrl.signal,
      cache: "no-store",
      headers: { Authorization: authHeader() },
    });
    if (!res.ok) throw new Error(`models HTTP ${res.status}`);
    // Response shape (verified against DataForSEO docs): the model objects sit
    // DIRECTLY in tasks[0].result[] — { model_name, reasoning,
    // web_search_supported, task_post_supported }.
    const data = (await res.json()) as {
      tasks?: {
        result?: { model_name?: string; web_search_supported?: boolean }[];
      }[];
    };
    const models: { name: string; web: boolean }[] = [];
    for (const m of data.tasks?.[0]?.result ?? []) {
      if (typeof m.model_name === "string") {
        models.push({ name: m.model_name, web: m.web_search_supported === true });
      }
    }
    if (models.length === 0) throw new Error("models list empty");
    // Prefer web-search-capable models (citations need grounding), then any.
    const pools = [models.filter((m) => m.web), models];
    let chosen = "";
    for (const pool of pools) {
      for (const pref of MODEL_PREFS[engine]) {
        const hit = pool.find((m) => pref.test(m.name));
        if (hit) {
          chosen = hit.name;
          break;
        }
      }
      if (!chosen && pool.length > 0) chosen = pool[0].name;
      if (chosen) break;
    }
    modelCache.set(engine, chosen);
    return chosen;
  } finally {
    clearTimeout(timer);
  }
}

// ── Live prompt run ───────────────────────────────────────────

export interface LlmPromptResult {
  answer: string;
  citations: PromptCitation[];
  modelName: string;
  webSearchUsed: boolean;
  /** What DataForSEO charged for this call (envelope cost, USD). */
  costUsd: number;
}

interface DfsLlmEnvelope {
  cost?: number;
  tasks?: {
    status_code?: number;
    status_message?: string;
    result?: {
      model_name?: string;
      web_search?: boolean;
      items?: {
        type?: string;
        sections?: {
          type?: string;
          text?: string;
          annotations?: { title?: string; url?: string }[];
        }[];
      }[];
    }[];
  }[];
}

/**
 * Run one prompt against one engine, live. Returns the real answer +
 * citations. Throws on provider/task errors (caller records status='error').
 */
export async function runLlmPrompt(
  engine: PromptEngine,
  prompt: string
): Promise<LlmPromptResult> {
  const modelName = await pickModel(engine);

  const payload: Record<string, unknown> = {
    user_prompt: prompt.slice(0, 500),
    model_name: modelName,
    max_output_tokens: 1024,
    temperature: 0,
  };
  // Web grounding: ChatGPT supports (and we force) search; Gemini and Claude
  // expose a web_search flag; Perplexity's sonar models search by default and
  // take no flag.
  if (engine === "chat_gpt") {
    payload.web_search = true;
    payload.force_web_search = true;
  } else if (engine === "gemini" || engine === "claude") {
    payload.web_search = true;
  }

  try {
    return await postLive(engine, payload);
  } catch (err) {
    // Model-quirk retries: some models reject specific fields (e.g. ChatGPT
    // reasoning-family models 40501 "does not support 'temperature'"; an
    // engine may reject web-search flags). Strip the offending field and
    // retry once rather than failing the whole check. Temperature is checked
    // FIRST — its error message also matches the generic "Invalid Field".
    const msg = String((err as Error)?.message ?? "");
    if (/temperature/i.test(msg) && "temperature" in payload) {
      const { temperature: _t, ...bare } = payload;
      return await postLive(engine, bare);
    }
    if (/web_search|force_web_search|invalid field/i.test(msg) && "web_search" in payload) {
      const { web_search: _a, force_web_search: _b, ...bare } = payload;
      return await postLive(engine, bare);
    }
    throw err;
  }
}

async function postLive(
  engine: PromptEngine,
  payload: Record<string, unknown>
): Promise<LlmPromptResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}/ai_optimization/${engine}/llm_responses/live`, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        Authorization: authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as DfsLlmEnvelope;
    const task = data.tasks?.[0];
    if (!task || (task.status_code ?? 0) >= 40000) {
      throw new Error(
        `DataForSEO task error: ${task?.status_code} ${task?.status_message ?? ""}`
      );
    }
    const result = task.result?.[0];
    const textParts: string[] = [];
    const citations: PromptCitation[] = [];
    const seenUrls = new Set<string>();
    for (const item of result?.items ?? []) {
      // Skip reasoning traces; the consumer-visible answer is type "message".
      if (item.type && item.type !== "message" && item.type !== "text") continue;
      for (const sec of item.sections ?? []) {
        if (typeof sec.text === "string" && sec.text) textParts.push(sec.text);
        for (const a of sec.annotations ?? []) {
          if (typeof a.url === "string" && a.url && !seenUrls.has(a.url)) {
            seenUrls.add(a.url);
            citations.push({ title: (a.title ?? "").slice(0, 200), url: a.url });
          }
        }
      }
    }
    return {
      answer: textParts.join("\n").trim(),
      citations,
      modelName: result?.model_name ?? String(payload.model_name ?? ""),
      webSearchUsed: result?.web_search === true || citations.length > 0,
      costUsd: typeof data.cost === "number" ? data.cost : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}
