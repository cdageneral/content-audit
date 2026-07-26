// ─────────────────────────────────────────────────────────────
//  LLM Prompt Set persistence — per-project buyer-intent prompts
//  and their per-engine check results (ChatGPT / Claude / Gemini /
//  Perplexity via DataForSEO LLM Responses).
//
//  Honesty contract: a prompt_checks row is only ever written from a
//  REAL provider response (or a real error). "cited" means the
//  engine's answer carried a citation link to the client's site;
//  "brand_mentioned" means the client's name appeared in the answer
//  text. Nothing here is estimated, and no volume figures exist for
//  prompts by design (all vendor prompt-volume numbers are modeled).
//
//  Lazy idempotent DDL, FK-free — same pattern as lib/db/serp.ts.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

export const PROMPT_ENGINES = ["chat_gpt", "claude", "gemini", "perplexity"] as const;
export type PromptEngine = (typeof PROMPT_ENGINES)[number];

export const ENGINE_LABELS: Record<PromptEngine, string> = {
  chat_gpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  perplexity: "Perplexity",
};

/**
 * Content-quality dimensions a prompt can map to (URL-level model,
 * 2026-07-26): the head search term matches a page's core intent; prompts
 * probe the quality dimensions — core intent, edge cases, implied
 * questions, and fan-out queries. Keys match ScoreDimension names.
 */
export const PROMPT_DIMENSIONS = [
  "coreIntent",
  "edgeCases",
  "impliedQuestions",
  "fanOutQueries",
] as const;
export type PromptDimension = (typeof PROMPT_DIMENSIONS)[number];

export const PROMPT_DIMENSION_LABELS: Record<PromptDimension, string> = {
  coreIntent: "Core intent",
  edgeCases: "Edge cases",
  impliedQuestions: "Implied questions",
  fanOutQueries: "Fan-out",
};

let promptSchemaReady: Promise<void> | null = null;

export function ensurePromptSchema(): Promise<void> {
  if (!promptSchemaReady) {
    promptSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS project_prompts (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL,
          prompt     TEXT NOT NULL,
          target_url TEXT,
          active     BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_project_prompts_project
        ON project_prompts(project_id, created_at)
      `;
      // URL-level prompt model (2026-07-26): which quality dimension the
      // prompt probes, and whether it was hand-entered or generated from the
      // page's scored dimensions. Lazy ALTERs — existing rows stay valid.
      await sql`
        ALTER TABLE project_prompts ADD COLUMN IF NOT EXISTS dimension TEXT
      `;
      await sql`
        ALTER TABLE project_prompts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'manual'
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS prompt_checks (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id      UUID NOT NULL,
          prompt_id       UUID NOT NULL,
          run_id          UUID NOT NULL,
          engine          TEXT NOT NULL,
          model_name      TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'ok',
          cited           BOOLEAN NOT NULL DEFAULT FALSE,
          cited_url       TEXT,
          brand_mentioned BOOLEAN NOT NULL DEFAULT FALSE,
          citations       JSONB NOT NULL DEFAULT '[]',
          answer_excerpt  TEXT NOT NULL DEFAULT '',
          web_search      BOOLEAN NOT NULL DEFAULT FALSE,
          cost_usd        REAL,
          error           TEXT,
          checked_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_prompt_checks_prompt
        ON prompt_checks(prompt_id, checked_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_prompt_checks_project
        ON prompt_checks(project_id, checked_at DESC)
      `;
    })().catch((err) => {
      promptSchemaReady = null; // allow retry instead of caching the failure
      throw err;
    });
  }
  return promptSchemaReady;
}

// ── Types ─────────────────────────────────────────────────────

export interface ProjectPrompt {
  id: string;
  projectId: string;
  prompt: string;
  targetUrl: string | null;
  /** Quality dimension this prompt probes, when known. */
  dimension: PromptDimension | null;
  /** "manual" (typed into the hub card) or "generated" (from scored dims). */
  source: "manual" | "generated";
  active: boolean;
  createdAt: string; // ISO — serializable across the server→client boundary
}

export interface PromptCitation {
  title: string;
  url: string;
}

export interface PromptCheck {
  id: string;
  promptId: string;
  runId: string;
  engine: PromptEngine;
  modelName: string;
  status: "ok" | "error";
  cited: boolean;
  citedUrl: string | null;
  brandMentioned: boolean;
  citations: PromptCitation[];
  answerExcerpt: string;
  webSearch: boolean;
  costUsd: number | null;
  error: string | null;
  checkedAt: string; // ISO
}

/** One prompt with its latest check per engine — the card/strip row shape. */
export interface PromptRow {
  id: string;
  prompt: string;
  targetUrl: string | null;
  dimension: PromptDimension | null;
  source: "manual" | "generated";
  checks: Partial<Record<PromptEngine, PromptCheck>>;
}

// Raised 50 → 150 (2026-07-26): prompt sets are now generated per URL
// (≤12 each), so a project's cap must hold more than a handful of pages.
const MAX_PROMPTS_PER_PROJECT = 150;
/** Cap on prompts mapped to one URL — keeps a per-page check run ≤48 calls. */
export const MAX_PROMPTS_PER_URL = 12;
const MAX_PROMPT_CHARS = 500; // DataForSEO user_prompt hard limit

// ── Prompt CRUD ───────────────────────────────────────────────

export async function listPrompts(projectId: string): Promise<ProjectPrompt[]> {
  await ensurePromptSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM project_prompts
    WHERE project_id = ${projectId} AND active = TRUE
    ORDER BY created_at ASC
  `;
  return rows.map(rowToPrompt);
}

export async function addPrompts(
  projectId: string,
  texts: string[]
): Promise<{ added: number; skipped: number }> {
  await ensurePromptSchema();
  const sql = db();
  const existing = await listPrompts(projectId);
  const seen = new Set(existing.map((p) => p.prompt.trim().toLowerCase()));
  let added = 0;
  let skipped = 0;
  for (const raw of texts) {
    const text = raw.trim().slice(0, MAX_PROMPT_CHARS);
    if (!text || seen.has(text.toLowerCase())) {
      skipped++;
      continue;
    }
    if (existing.length + added >= MAX_PROMPTS_PER_PROJECT) {
      skipped++;
      continue;
    }
    await sql`
      INSERT INTO project_prompts (project_id, prompt) VALUES (${projectId}, ${text})
    `;
    seen.add(text.toLowerCase());
    added++;
  }
  return { added, skipped };
}

/**
 * Insert generated, dimension-labeled prompts pre-mapped to one URL.
 * Dedupe is project-wide (same text = same prompt regardless of page);
 * both the per-URL cap and the project cap are enforced here so a
 * client can't overfill either by replaying the generate call.
 */
export async function addGeneratedPrompts(
  projectId: string,
  targetUrl: string,
  items: { prompt: string; dimension: PromptDimension }[]
): Promise<{ added: number; skipped: number }> {
  await ensurePromptSchema();
  const sql = db();
  const existing = await listPrompts(projectId);
  const seen = new Set(existing.map((p) => p.prompt.trim().toLowerCase()));
  const key = urlKey(targetUrl);
  let onUrl = existing.filter((p) => p.targetUrl && urlKey(p.targetUrl) === key).length;
  let added = 0;
  let skipped = 0;
  for (const item of items) {
    const text = item.prompt.trim().slice(0, MAX_PROMPT_CHARS);
    const dim = PROMPT_DIMENSIONS.includes(item.dimension) ? item.dimension : null;
    if (!text || !dim || seen.has(text.toLowerCase())) {
      skipped++;
      continue;
    }
    if (onUrl >= MAX_PROMPTS_PER_URL || existing.length + added >= MAX_PROMPTS_PER_PROJECT) {
      skipped++;
      continue;
    }
    await sql`
      INSERT INTO project_prompts (project_id, prompt, target_url, dimension, source)
      VALUES (${projectId}, ${text}, ${targetUrl}, ${dim}, 'generated')
    `;
    seen.add(text.toLowerCase());
    added++;
    onUrl++;
  }
  return { added, skipped };
}

export async function deletePrompt(projectId: string, promptId: string): Promise<void> {
  await ensurePromptSchema();
  const sql = db();
  // Soft delete: check history stays attributable in the cost ledger.
  await sql`
    UPDATE project_prompts SET active = FALSE
    WHERE id = ${promptId} AND project_id = ${projectId}
  `;
}

export async function setPromptTarget(
  projectId: string,
  promptId: string,
  targetUrl: string | null
): Promise<void> {
  await ensurePromptSchema();
  const sql = db();
  await sql`
    UPDATE project_prompts SET target_url = ${targetUrl}
    WHERE id = ${promptId} AND project_id = ${projectId}
  `;
}

export async function getPromptsByIds(
  projectId: string,
  ids: string[]
): Promise<ProjectPrompt[]> {
  if (ids.length === 0) return [];
  await ensurePromptSchema();
  const sql = db();
  const rows = await sql`
    SELECT * FROM project_prompts
    WHERE project_id = ${projectId} AND id = ANY(${ids}) AND active = TRUE
  `;
  return rows.map(rowToPrompt);
}

// ── Check writes/reads ────────────────────────────────────────

export async function insertPromptCheck(c: {
  projectId: string;
  promptId: string;
  runId: string;
  engine: PromptEngine;
  modelName: string;
  status: "ok" | "error";
  cited: boolean;
  citedUrl: string | null;
  brandMentioned: boolean;
  citations: PromptCitation[];
  answerExcerpt: string;
  webSearch: boolean;
  costUsd: number | null;
  error: string | null;
}): Promise<void> {
  await ensurePromptSchema();
  const sql = db();
  await sql`
    INSERT INTO prompt_checks
      (project_id, prompt_id, run_id, engine, model_name, status, cited, cited_url,
       brand_mentioned, citations, answer_excerpt, web_search, cost_usd, error)
    VALUES
      (${c.projectId}, ${c.promptId}, ${c.runId}, ${c.engine}, ${c.modelName},
       ${c.status}, ${c.cited}, ${c.citedUrl}, ${c.brandMentioned},
       ${JSON.stringify(c.citations)}, ${c.answerExcerpt}, ${c.webSearch},
       ${c.costUsd}, ${c.error})
  `;
}

/** Latest check per (prompt, engine) for a project. */
export async function getLatestChecks(projectId: string): Promise<PromptCheck[]> {
  await ensurePromptSchema();
  const sql = db();
  const rows = await sql`
    SELECT DISTINCT ON (prompt_id, engine) *
    FROM prompt_checks
    WHERE project_id = ${projectId}
    ORDER BY prompt_id, engine, checked_at DESC
  `;
  return rows.map(rowToCheck);
}

/** Prompt rows (prompt + latest check per engine) for the hub card. */
export async function getPromptRows(projectId: string): Promise<PromptRow[]> {
  const [prompts, checks] = await Promise.all([
    listPrompts(projectId),
    getLatestChecks(projectId).catch(() => [] as PromptCheck[]),
  ]);
  const byPrompt = new Map<string, Partial<Record<PromptEngine, PromptCheck>>>();
  for (const c of checks) {
    const m = byPrompt.get(c.promptId) ?? {};
    m[c.engine] = c;
    byPrompt.set(c.promptId, m);
  }
  return prompts.map((p) => ({
    id: p.id,
    prompt: p.prompt,
    targetUrl: p.targetUrl,
    dimension: p.dimension,
    source: p.source,
    checks: byPrompt.get(p.id) ?? {},
  }));
}

/**
 * Prompts relevant to one page URL: assigned to it (target_url), or whose
 * latest check on any engine cited it. urlKey-insensitive (www/slash/case).
 */
export async function getPromptRowsForUrl(
  projectId: string | null,
  pageUrl: string
): Promise<PromptRow[]> {
  try {
    if (!projectId) return [];
    const rows = await getPromptRows(projectId);
    const key = urlKey(pageUrl);
    return rows.filter((r) => {
      if (r.targetUrl && urlKey(r.targetUrl) === key) return true;
      for (const c of Object.values(r.checks)) {
        if (c?.citedUrl && urlKey(c.citedUrl) === key) return true;
      }
      return false;
    });
  } catch (err) {
    console.error(`[prompts] rows-for-url failed for ${pageUrl}:`, err);
    return [];
  }
}

/** Paid checks in the last 24h — cost-control counter. */
export async function countRecentChecks(projectId: string): Promise<number> {
  await ensurePromptSchema();
  const sql = db();
  const rows = await sql`
    SELECT COUNT(*)::int AS n FROM prompt_checks
    WHERE project_id = ${projectId} AND checked_at > NOW() - INTERVAL '24 hours'
  `;
  return (rows[0]?.n as number) ?? 0;
}

/** Sum of real provider cost for the latest run (for the card footer). */
export async function getLastRunSummary(
  projectId: string
): Promise<{ runId: string; at: string; costUsd: number; checks: number; errors: number } | null> {
  await ensurePromptSchema();
  const sql = db();
  const last = await sql`
    SELECT run_id FROM prompt_checks
    WHERE project_id = ${projectId}
    ORDER BY checked_at DESC LIMIT 1
  `;
  if (last.length === 0) return null;
  const runId = last[0].run_id as string;
  const agg = await sql`
    SELECT COUNT(*)::int AS n,
           COUNT(*) FILTER (WHERE status = 'error')::int AS errs,
           COALESCE(SUM(cost_usd), 0)::real AS cost,
           MAX(checked_at) AS at
    FROM prompt_checks
    WHERE project_id = ${projectId} AND run_id = ${runId}
  `;
  return {
    runId,
    at: new Date(agg[0].at as string).toISOString(),
    costUsd: (agg[0].cost as number) ?? 0,
    checks: (agg[0].n as number) ?? 0,
    errors: (agg[0].errs as number) ?? 0,
  };
}

// ── Helpers ───────────────────────────────────────────────────

/** Same loose URL identity as the webhook's urlKey (www/slash/case-insensitive). */
export function urlKey(u: string): string {
  return u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

function rowToPrompt(r: Record<string, unknown>): ProjectPrompt {
  const dim = r.dimension as string | null;
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    prompt: r.prompt as string,
    targetUrl: (r.target_url as string | null) ?? null,
    dimension: PROMPT_DIMENSIONS.includes(dim as PromptDimension)
      ? (dim as PromptDimension)
      : null,
    source: r.source === "generated" ? "generated" : "manual",
    active: (r.active as boolean) ?? true,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

function rowToCheck(r: Record<string, unknown>): PromptCheck {
  return {
    id: r.id as string,
    promptId: r.prompt_id as string,
    runId: r.run_id as string,
    engine: r.engine as PromptEngine,
    modelName: (r.model_name as string) ?? "",
    status: (r.status as "ok" | "error") ?? "ok",
    cited: (r.cited as boolean) ?? false,
    citedUrl: (r.cited_url as string | null) ?? null,
    brandMentioned: (r.brand_mentioned as boolean) ?? false,
    citations: (r.citations as PromptCitation[]) ?? [],
    answerExcerpt: (r.answer_excerpt as string) ?? "",
    webSearch: (r.web_search as boolean) ?? false,
    costUsd: (r.cost_usd as number | null) ?? null,
    error: (r.error as string | null) ?? null,
    checkedAt: new Date(r.checked_at as string).toISOString(),
  };
}
