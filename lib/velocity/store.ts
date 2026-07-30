// ─────────────────────────────────────────────────────────────
//  lib/velocity/store.ts — competitor publishing-velocity
//  persistence (server-only).
//
//  content_inventory: one row per (project, site, URL) — the
//  observed URL registry that publishing velocity is computed
//  from. Rows are written at scan time from two honest sources:
//    · the crawl  (publish dates extracted from the page itself)
//    · the sitemap (URL set + lastmod hints, beyond the crawl cap)
//  first_seen_job records the scan a URL first appeared in — the
//  observed fact scan-over-scan velocity is built on. Nothing in
//  this table is modeled or estimated.
//
//  Same lazy idempotent-DDL pattern as lib/schedule/store.ts, the
//  same mandatory Neon no-store option, and NO ON CONFLICT — the
//  dedupe index is an expression index (COALESCE on competitor_id
//  so client rows dedupe too), which ON CONFLICT can't target
//  reliably (see the upsertScore 42P10 postmortem). Upserts are
//  select-then-split instead.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let velocitySchemaReady: Promise<void> | null = null;

export function ensureVelocitySchema(): Promise<void> {
  if (!velocitySchemaReady) {
    velocitySchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS content_inventory (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id       UUID NOT NULL,
          competitor_id    UUID,
          url              TEXT NOT NULL,
          published_at     TIMESTAMPTZ,
          published_source TEXT,
          lastmod          TIMESTAMPTZ,
          first_seen_job   UUID,
          first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      // Expression index: COALESCE folds NULL competitor_id (= the client
      // site) into a sentinel so client URLs dedupe like competitor URLs.
      await sql`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_content_inventory_dedupe
        ON content_inventory (project_id, url, COALESCE(competitor_id, '00000000-0000-0000-0000-000000000000'::uuid))
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_content_inventory_project
        ON content_inventory (project_id, competitor_id)
      `;
    })().catch((err) => {
      velocitySchemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return velocitySchemaReady;
}

export interface InventoryEntry {
  url: string;
  /** ISO string — publish date read from the page itself (or sitemap lastmod when source is 'sitemap'). */
  publishedAt: string | null;
  /** Where publishedAt came from: 'page' (metadata/JSON-LD/URL) — sitemap lastmod is stored separately. */
  publishedSource: string | null;
  /** ISO string — sitemap <lastmod>, stored as a hint, never presented as a publish date. */
  lastmod: string | null;
}

/**
 * Record a scan's observed URL set for one site (client or competitor).
 * Idempotent: existing rows keep their first_seen_job/first_seen_at; only
 * last_seen_at advances, and date fields fill in when previously unknown.
 */
export async function recordInventory(input: {
  projectId: string;
  competitorId: string | null;
  jobId: string;
  entries: InventoryEntry[];
}): Promise<{ inserted: number; updated: number }> {
  const { projectId, competitorId, jobId } = input;
  if (input.entries.length === 0) return { inserted: 0, updated: 0 };
  await ensureVelocitySchema();
  const sql = db();

  // Dedupe by URL within the incoming batch (crawl + sitemap often overlap):
  // page-extracted dates win over sitemap-only rows.
  const byUrl = new Map<string, InventoryEntry>();
  for (const e of input.entries) {
    const prev = byUrl.get(e.url);
    if (!prev) {
      byUrl.set(e.url, { ...e });
    } else {
      byUrl.set(e.url, {
        url: e.url,
        publishedAt: prev.publishedAt ?? e.publishedAt,
        publishedSource: prev.publishedAt ? prev.publishedSource : e.publishedAt ? e.publishedSource : null,
        lastmod: prev.lastmod ?? e.lastmod,
      });
    }
  }
  const entries = Array.from(byUrl.values()).slice(0, 8000);

  let inserted = 0;
  let updated = 0;

  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const chunk = entries.slice(i, i + CHUNK);
    const urls = chunk.map((e) => e.url);

    const existingRows = await sql`
      SELECT url FROM content_inventory
      WHERE project_id = ${projectId}
        AND competitor_id IS NOT DISTINCT FROM ${competitorId}
        AND url = ANY(${urls})
    `;
    const existing = new Set(existingRows.map((r) => String(r.url)));

    const toInsert = chunk.filter((e) => !existing.has(e.url));
    const toUpdate = chunk.filter((e) => existing.has(e.url));

    if (toInsert.length > 0) {
      await sql`
        INSERT INTO content_inventory
          (project_id, competitor_id, url, published_at, published_source, lastmod, first_seen_job)
        SELECT ${projectId}, ${competitorId}, r.url,
               r.published_at::timestamptz, r.published_source, r.lastmod::timestamptz, ${jobId}
        FROM jsonb_to_recordset(${JSON.stringify(toInsert.map((e) => ({
          url: e.url,
          published_at: e.publishedAt,
          published_source: e.publishedSource,
          lastmod: e.lastmod,
        })))}::jsonb)
        AS r(url TEXT, published_at TEXT, published_source TEXT, lastmod TEXT)
      `;
      inserted += toInsert.length;
    }

    if (toUpdate.length > 0) {
      await sql`
        UPDATE content_inventory ci SET
          last_seen_at     = NOW(),
          published_at     = COALESCE(ci.published_at, r.published_at::timestamptz),
          published_source = CASE
            WHEN ci.published_at IS NULL AND r.published_at IS NOT NULL THEN r.published_source
            ELSE ci.published_source
          END,
          lastmod          = COALESCE(r.lastmod::timestamptz, ci.lastmod)
        FROM jsonb_to_recordset(${JSON.stringify(toUpdate.map((e) => ({
          url: e.url,
          published_at: e.publishedAt,
          published_source: e.publishedSource,
          lastmod: e.lastmod,
        })))}::jsonb)
        AS r(url TEXT, published_at TEXT, published_source TEXT, lastmod TEXT)
        WHERE ci.project_id = ${projectId}
          AND ci.competitor_id IS NOT DISTINCT FROM ${competitorId}
          AND ci.url = r.url
      `;
      updated += toUpdate.length;
    }
  }

  return { inserted, updated };
}

export interface InventoryRow {
  competitorId: string | null;
  url: string;
  publishedAt: Date | null;
  publishedSource: string | null;
  lastmod: Date | null;
  firstSeenJob: string | null;
  firstSeenAt: Date;
}

/** Every inventory row for a project (client + all competitors). */
export async function getInventoryByProject(projectId: string): Promise<InventoryRow[]> {
  await ensureVelocitySchema();
  const sql = db();
  const rows = await sql`
    SELECT competitor_id, url, published_at, published_source, lastmod, first_seen_job, first_seen_at
    FROM content_inventory
    WHERE project_id = ${projectId}
  `;
  return rows.map((r) => ({
    competitorId: r.competitor_id ? String(r.competitor_id) : null,
    url: String(r.url),
    publishedAt: r.published_at ? new Date(String(r.published_at)) : null,
    publishedSource: r.published_source ? String(r.published_source) : null,
    lastmod: r.lastmod ? new Date(String(r.lastmod)) : null,
    firstSeenJob: r.first_seen_job ? String(r.first_seen_job) : null,
    firstSeenAt: new Date(String(r.first_seen_at)),
  }));
}

/** Remove all inventory rows for a project (project deletion cleanup). */
export async function deleteInventoryByProject(projectId: string): Promise<void> {
  await ensureVelocitySchema();
  const sql = db();
  await sql`DELETE FROM content_inventory WHERE project_id = ${projectId}`;
}

/** Remove one competitor's inventory rows (competitor deletion cleanup). */
export async function deleteInventoryByCompetitor(competitorId: string): Promise<void> {
  await ensureVelocitySchema();
  const sql = db();
  await sql`DELETE FROM content_inventory WHERE competitor_id = ${competitorId}`;
}
