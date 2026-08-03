// ─────────────────────────────────────────────────────────────
//  Business Impact — server-side data assembly. Reads what the
//  scans already stored (ZERO new API calls):
//
//    · Google baseline — the rank rollup's verified demand figures
//      (striking-distance volume per keyword, AIO exposure).
//    · AI baseline — the prompt set and its latest per-engine
//      citation checks (real provider responses only).
//    · Persisted inputs — the client's own numbers (industry,
//      conversion override, value per lead, GA4 AI visits), stored
//      per project in project_impact_inputs.
//
//  Lazy idempotent DDL, FK-free — same pattern as lib/db/prompts.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { getRankRollup } from "@/lib/rankings/rollup";
import { getPromptRows } from "@/lib/db/prompts";
import {
  AI_PREMIUM_DEFAULT,
  DEFAULT_INPUTS,
  industryByKey,
  type AiBaseline,
  type GoogleBaseline,
  type ImpactInputs,
} from "@/lib/impact/model";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let impactSchemaReady: Promise<void> | null = null;

export function ensureImpactSchema(): Promise<void> {
  if (!impactSchemaReady) {
    impactSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS project_impact_inputs (
          project_id   UUID PRIMARY KEY,
          industry     TEXT,
          conv_rate    REAL,
          lead_value   REAL,
          ai_visits    REAL,
          ai_premium   REAL NOT NULL DEFAULT 4.4,
          aio_discount BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
    })().catch((err) => {
      impactSchemaReady = null; // allow retry instead of caching the failure
      throw err;
    });
  }
  return impactSchemaReady;
}

// ── Persisted inputs ──────────────────────────────────────────

export async function getImpactInputs(projectId: string): Promise<ImpactInputs> {
  await ensureImpactSchema();
  const sql = db();
  const rows = await sql`
    SELECT industry, conv_rate, lead_value, ai_visits, ai_premium, aio_discount
    FROM project_impact_inputs WHERE project_id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  if (rows.length === 0) return { ...DEFAULT_INPUTS };
  const r = rows[0];
  const industry = industryByKey(r.industry as string | null)?.key ?? null;
  return {
    industry,
    convRate: r.conv_rate === null ? null : Number(r.conv_rate),
    leadValue: r.lead_value === null ? null : Number(r.lead_value),
    aiVisits: r.ai_visits === null ? null : Number(r.ai_visits),
    aiPremium: r.ai_premium === null ? AI_PREMIUM_DEFAULT : Number(r.ai_premium),
    aioDiscount: Boolean(r.aio_discount),
  };
}

export async function saveImpactInputs(
  projectId: string,
  inp: ImpactInputs
): Promise<void> {
  await ensureImpactSchema();
  const sql = db();
  await sql`
    INSERT INTO project_impact_inputs
      (project_id, industry, conv_rate, lead_value, ai_visits, ai_premium, aio_discount, updated_at)
    VALUES
      (${projectId}, ${inp.industry}, ${inp.convRate}, ${inp.leadValue},
       ${inp.aiVisits}, ${inp.aiPremium}, ${inp.aioDiscount}, NOW())
    ON CONFLICT (project_id) DO UPDATE SET
      industry     = EXCLUDED.industry,
      conv_rate    = EXCLUDED.conv_rate,
      lead_value   = EXCLUDED.lead_value,
      ai_visits    = EXCLUDED.ai_visits,
      ai_premium   = EXCLUDED.ai_premium,
      aio_discount = EXCLUDED.aio_discount,
      updated_at   = NOW()
  `;
}

// ── Baselines ─────────────────────────────────────────────────

/**
 * Google baseline from the latest scan's rank rollup. Striking-distance
 * demand is summed per keyword from VERIFIED volumes only, with the
 * AIO-exposed share kept separate so the optional click discount can be
 * applied per keyword rather than as a blanket factor.
 */
export async function getGoogleBaseline(projectId: string): Promise<GoogleBaseline | null> {
  const rollup = await getRankRollup(projectId).catch(() => null);
  if (!rollup) return null;
  let strikingVol = 0;
  let strikingVolOnAio = 0;
  let strikingKeywords = 0;
  for (const k of rollup.keywords) {
    if (k.branded || k.volume === null) continue;
    if (k.position >= 11 && k.position <= 20) {
      strikingVol += k.volume;
      strikingKeywords++;
      if (k.aiPresent) strikingVolOnAio += k.volume;
    }
  }
  return {
    volumesOk: rollup.volumesOk,
    strikingVol,
    strikingVolOnAio,
    strikingKeywords,
    totalDemand: rollup.demand.total,
    top10Demand: rollup.demand.top10,
    covered: rollup.demand.covered,
    tracked: rollup.demand.tracked,
    fetchedAt: rollup.fetchedAt,
  };
}

/**
 * AI baseline from the prompt set. "Cited" means the latest successful
 * check on ≥1 engine carried a citation link to the client's site — a
 * real provider response, never an estimate.
 */
export async function getAiBaseline(projectId: string): Promise<AiBaseline> {
  const rows = await getPromptRows(projectId).catch(() => []);
  let promptsChecked = 0;
  let promptsCited = 0;
  const engines = new Set<string>();
  for (const row of rows) {
    const checks = Object.values(row.checks).filter((c) => c && c.status === "ok");
    if (checks.length > 0) {
      promptsChecked++;
      for (const c of checks) engines.add(c!.engine);
      if (checks.some((c) => c!.cited)) promptsCited++;
    }
  }
  return {
    promptsTotal: rows.length,
    promptsChecked,
    promptsCited,
    engines: Array.from(engines),
    measured: promptsChecked > 0,
  };
}

export interface ImpactPageData {
  google: GoogleBaseline | null;
  ai: AiBaseline;
  inputs: ImpactInputs;
}

export async function getImpactPageData(projectId: string): Promise<ImpactPageData> {
  const [google, ai, inputs] = await Promise.all([
    getGoogleBaseline(projectId),
    getAiBaseline(projectId),
    getImpactInputs(projectId).catch(() => ({ ...DEFAULT_INPUTS })),
  ]);
  return { google, ai, inputs };
}
