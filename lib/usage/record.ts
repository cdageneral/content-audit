// ─────────────────────────────────────────────────────────────
//  API usage recorder — the ONE entry point every outbound API
//  call reports through. Feeds the super-admin "API Usage" panel.
//
//  Rules:
//   • recordApiCall NEVER throws — usage tracking must never break a
//     scoring batch, a webhook handler, or a user-facing route.
//   • cost_usd is either EXACT (computed from reported token counts ×
//     published rates, or returned by the provider itself) or NULL.
//     NULL means "not priced" — never 0, never an estimate.
//   • New provider or call site? Call recordApiCall (or the
//     recordAnthropicCall convenience below) with a distinct `purpose`
//     and it shows up in the panel automatically.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import {
  computeAnthropicCostUsd,
  type AnthropicUsageLike,
} from "./pricing";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  // no-store: same Neon/Next Data Cache gotcha as lib/db/client.ts — without
  // it, admin-panel reads of api_calls would return stale snapshots forever.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

// ── Lazy schema (same pattern as ensureSchemaPatches) ─────────
let usageSchemaEnsured: Promise<void> | null = null;

export function ensureUsageSchema(): Promise<void> {
  if (!usageSchemaEnsured) {
    usageSchemaEnsured = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS api_calls (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider       TEXT NOT NULL,
          purpose        TEXT NOT NULL,
          model          TEXT,
          input_tokens   INTEGER,
          output_tokens  INTEGER,
          cost_usd       NUMERIC(12,6),
          project_id     UUID,
          job_id         UUID,
          page_url       TEXT,
          meta           JSONB NOT NULL DEFAULT '{}',
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      // No FKs on purpose: usage history must SURVIVE project/job deletion —
      // it's a cost ledger, not app state.
      await sql`
        CREATE INDEX IF NOT EXISTS idx_api_calls_created ON api_calls(created_at DESC)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_api_calls_job ON api_calls(job_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_api_calls_project ON api_calls(project_id)
      `;
      // Per-project monthly budget for the over-budget flag in the panel.
      // Separate try/catch: if `projects` somehow doesn't exist yet, the
      // api_calls ledger must still work.
      try {
        await sql`
          ALTER TABLE projects ADD COLUMN IF NOT EXISTS monthly_budget_usd NUMERIC(12,2)
        `;
      } catch (err) {
        console.warn("[usage] budget column patch skipped:", err);
      }
    })().catch((err) => {
      // Allow a retry on the next call instead of caching the failure forever.
      usageSchemaEnsured = null;
      throw err;
    });
  }
  return usageSchemaEnsured;
}

// ── Core recorder ─────────────────────────────────────────────

export interface ApiCallInput {
  provider: "anthropic" | "dataforseo" | "semrush" | "qstash" | string;
  purpose: string; // 'score' | 'classify' | 'simulate' | 'verify' | 'rewrite' | 'generate' | 'research' | 'gap_brief' | 'serp_keywords' | 'serp_live' | 'serp_questions' | 'queue_publish' | 'test' | ...
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Exact USD cost, or null/undefined when unknown — NEVER an estimate. */
  costUsd?: number | null;
  projectId?: string | null;
  jobId?: string | null;
  pageUrl?: string | null;
  meta?: Record<string, unknown>;
}

export async function recordApiCall(c: ApiCallInput): Promise<void> {
  try {
    await ensureUsageSchema();
    const sql = db();
    await sql`
      INSERT INTO api_calls
        (provider, purpose, model, input_tokens, output_tokens, cost_usd,
         project_id, job_id, page_url, meta)
      VALUES
        (${c.provider}, ${c.purpose}, ${c.model ?? null},
         ${c.inputTokens ?? null}, ${c.outputTokens ?? null}, ${c.costUsd ?? null},
         ${c.projectId ?? null}, ${c.jobId ?? null}, ${c.pageUrl ?? null},
         ${JSON.stringify(c.meta ?? {})})
    `;
  } catch (err) {
    // Never let bookkeeping break the actual work.
    console.warn("[usage] failed to record api call:", err);
  }
}

// ── Anthropic convenience wrapper ─────────────────────────────

export async function recordAnthropicCall(args: {
  purpose: string;
  model: string;
  usage: AnthropicUsageLike | null | undefined;
  projectId?: string | null;
  jobId?: string | null;
  pageUrl?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { costUsd, rateKnown, webSearchRequests } = computeAnthropicCostUsd(
    args.model,
    args.usage
  );
  const meta: Record<string, unknown> = { ...(args.meta ?? {}) };
  if (!rateKnown) meta.rate_unknown = true;
  if (webSearchRequests > 0) meta.web_search_requests = webSearchRequests;
  const cacheW = args.usage?.cache_creation_input_tokens ?? 0;
  const cacheR = args.usage?.cache_read_input_tokens ?? 0;
  if (cacheW) meta.cache_creation_input_tokens = cacheW;
  if (cacheR) meta.cache_read_input_tokens = cacheR;

  await recordApiCall({
    provider: "anthropic",
    purpose: args.purpose,
    model: args.model,
    inputTokens: args.usage?.input_tokens ?? null,
    outputTokens: args.usage?.output_tokens ?? null,
    costUsd,
    projectId: args.projectId ?? null,
    jobId: args.jobId ?? null,
    pageUrl: args.pageUrl ?? null,
    meta,
  });
}
