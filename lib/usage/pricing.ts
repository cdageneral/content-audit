// ─────────────────────────────────────────────────────────────
//  API pricing tables — REAL published rates only, never guessed.
//
//  Sources (verified 2026-07-23):
//   • Anthropic model rates:
//     https://platform.claude.com/docs/en/about-claude/pricing
//   • Anthropic web_search server tool ($10 per 1,000 searches):
//     https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
//   • Upstash QStash ($1 per 100K messages pay-as-you-go; free tier 1,000/day):
//     https://upstash.com/pricing/qstash
//
//  DataForSEO needs no table here — every DataForSEO response carries the
//  exact charged cost, which we record verbatim. Semrush bills in API units
//  whose $ value depends on the plan, so Semrush calls are recorded with
//  units in meta and cost_usd NULL (shown as "units" in the panel, never a
//  made-up dollar figure).
//
//  HONESTY CONTRACT: if a model id has no entry below, computeAnthropicCostUsd
//  returns { costUsd: null, rateKnown: false } and the call is stored with
//  cost NULL + meta.rate_unknown — flagged in the admin panel instead of
//  silently priced wrong. When Anthropic publishes new models/rates, add them
//  here (rates are USD per MILLION tokens).
// ─────────────────────────────────────────────────────────────

export const PRICING_ASOF = "2026-07-23";

interface Rate {
  inPerMTok: number;
  outPerMTok: number;
}

// Longest-prefix match against the model id (model ids are dated snapshots,
// e.g. "claude-haiku-4-5-20251001"). Order does not matter — the matcher
// always picks the LONGEST matching prefix.
const ANTHROPIC_RATES: Record<string, Rate> = {
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5 },
  "claude-3-5-haiku": { inPerMTok: 0.8, outPerMTok: 4 },
  "claude-haiku-3-5": { inPerMTok: 0.8, outPerMTok: 4 },
  "claude-sonnet-4-5": { inPerMTok: 3, outPerMTok: 15 },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15 },
  "claude-sonnet-4-2": { inPerMTok: 3, outPerMTok: 15 },
  "claude-sonnet-4-0": { inPerMTok: 3, outPerMTok: 15 },
  "claude-opus-4-5": { inPerMTok: 5, outPerMTok: 25 },
  "claude-opus-4-6": { inPerMTok: 5, outPerMTok: 25 },
  "claude-opus-4-7": { inPerMTok: 5, outPerMTok: 25 },
  "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25 },
  "claude-opus-4-1": { inPerMTok: 15, outPerMTok: 75 },
  "claude-opus-4-0": { inPerMTok: 15, outPerMTok: 75 },
  "claude-fable-5": { inPerMTok: 10, outPerMTok: 50 },
  "claude-mythos-5": { inPerMTok: 10, outPerMTok: 50 },
};

// Claude Sonnet 5 has published DATE-DEPENDENT pricing: $2/$10 intro through
// 2026-08-31, then $3/$15 from 2026-09-01 (source: Anthropic pricing page).
const SONNET_5_CUTOVER_MS = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z

function rateForModel(model: string, atMs: number): Rate | null {
  if (model.indexOf("claude-sonnet-5") === 0) {
    return atMs < SONNET_5_CUTOVER_MS
      ? { inPerMTok: 2, outPerMTok: 10 }
      : { inPerMTok: 3, outPerMTok: 15 };
  }
  let best: string | null = null;
  for (const prefix of Object.keys(ANTHROPIC_RATES)) {
    if (model.indexOf(prefix) === 0 && (!best || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best ? ANTHROPIC_RATES[best] : null;
}

// Prompt-cache multipliers (published, uniform across models):
// 5-minute cache writes bill 1.25× input; cache reads bill 0.1× input.
// This app doesn't use caching today, but the SDK reports the fields — if a
// future change turns caching on, the math is already correct.
const CACHE_WRITE_MULT = 1.25;
const CACHE_READ_MULT = 0.1;

export const WEB_SEARCH_USD_PER_CALL = 0.01; // $10 per 1,000 searches

// QStash pay-as-you-go: $1 per 100K messages. NOTE: on the free tier
// (1,000 msgs/day) the real bill is $0, and we can't see the account's plan
// from here — so QStash calls are recorded with cost_usd NULL and this rate
// in meta, and the panel shows message COUNTS with the published rate as a
// footnote rather than asserting a dollar figure that may not be billed.
export const QSTASH_PAYG_USD_PER_MESSAGE = 0.00001;

export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  server_tool_use?: { web_search_requests?: number | null } | null;
}

export interface CostResult {
  costUsd: number | null;
  rateKnown: boolean;
  webSearchRequests: number;
}

/**
 * Exact cost of one Anthropic call from its REPORTED usage object.
 * Unknown model → cost null (flagged), never an approximation.
 */
export function computeAnthropicCostUsd(
  model: string,
  usage: AnthropicUsageLike | null | undefined,
  atMs?: number
): CostResult {
  const webSearchRequests = usage?.server_tool_use?.web_search_requests ?? 0;
  const rate = rateForModel(model, atMs ?? Date.now());
  if (!rate || !usage) {
    return { costUsd: null, rateKnown: !!rate, webSearchRequests };
  }
  const inTok = usage.input_tokens ?? 0;
  const outTok = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;

  const usd =
    (inTok / 1_000_000) * rate.inPerMTok +
    (outTok / 1_000_000) * rate.outPerMTok +
    (cacheWrite / 1_000_000) * rate.inPerMTok * CACHE_WRITE_MULT +
    (cacheRead / 1_000_000) * rate.inPerMTok * CACHE_READ_MULT +
    webSearchRequests * WEB_SEARCH_USD_PER_CALL;

  // Round to microdollars — matches NUMERIC(12,6) storage.
  return {
    costUsd: Math.round(usd * 1_000_000) / 1_000_000,
    rateKnown: true,
    webSearchRequests,
  };
}
