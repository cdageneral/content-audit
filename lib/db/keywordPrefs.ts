// ─────────────────────────────────────────────────────────────
//  Per-URL keyword preferences — the head-term override and the
//  supporting-keyword selection for a page (URL-level visibility
//  model, 2026-07-26).
//
//  Honesty contract: prefs can only SELECT among keywords that
//  exist in the page's stored SERP snapshot (validated at the API
//  layer). A term the page doesn't rank for has no verified data
//  to show, so it can never become the displayed head term.
//
//  Keyed by (project_id, url_key) — NEVER by page id: a re-audit
//  mints new page rows for the same URL and prefs must survive
//  that (same lineage rule as drafts).
//
//  Lazy idempotent DDL, FK-free — same pattern as lib/db/serp.ts.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { urlKey } from "@/lib/db/prompts";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let prefsSchemaReady: Promise<void> | null = null;

export function ensureKeywordPrefsSchema(): Promise<void> {
  if (!prefsSchemaReady) {
    prefsSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS page_keyword_prefs (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id  UUID NOT NULL,
          url_key     TEXT NOT NULL,
          head_term   TEXT,
          supporting  JSONB,
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (project_id, url_key)
        )
      `;
    })().catch((err) => {
      prefsSchemaReady = null; // allow retry instead of caching the failure
      throw err;
    });
  }
  return prefsSchemaReady;
}

export interface KeywordPrefs {
  /** Head-term override (must be a stored ranked keyword), or null = auto. */
  headTerm: string | null;
  /**
   * Explicit supporting-keyword selection, or null = auto (every non-branded
   * ranked keyword except the head term counts as supporting).
   */
  supporting: string[] | null;
  updatedAt: string; // ISO
}

export async function getKeywordPrefs(
  projectId: string,
  pageUrl: string
): Promise<KeywordPrefs | null> {
  try {
    await ensureKeywordPrefsSchema();
    const sql = db();
    const rows = await sql`
      SELECT head_term, supporting, updated_at FROM page_keyword_prefs
      WHERE project_id = ${projectId} AND url_key = ${urlKey(pageUrl)}
    `;
    const r = rows[0];
    if (!r) return null;
    const supporting = Array.isArray(r.supporting)
      ? (r.supporting as unknown[]).filter((s): s is string => typeof s === "string")
      : null;
    return {
      headTerm: (r.head_term as string | null) ?? null,
      supporting,
      updatedAt: new Date(r.updated_at as string).toISOString(),
    };
  } catch (err) {
    // Enrichment, not a dependency — derived defaults still render.
    console.error(`[keywordPrefs] read failed for ${pageUrl}:`, err);
    return null;
  }
}

export async function upsertKeywordPrefs(
  projectId: string,
  pageUrl: string,
  prefs: { headTerm: string | null; supporting: string[] | null }
): Promise<void> {
  await ensureKeywordPrefsSchema();
  const sql = db();
  const supportingJson =
    prefs.supporting === null ? null : JSON.stringify(prefs.supporting);
  await sql`
    INSERT INTO page_keyword_prefs (project_id, url_key, head_term, supporting, updated_at)
    VALUES (${projectId}, ${urlKey(pageUrl)}, ${prefs.headTerm}, ${supportingJson}, NOW())
    ON CONFLICT (project_id, url_key) DO UPDATE
    SET head_term = EXCLUDED.head_term,
        supporting = EXCLUDED.supporting,
        updated_at = NOW()
  `;
}
