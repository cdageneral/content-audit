// ─────────────────────────────────────────────────────────────
//  lib/brand/store.ts — Brand & Context persistence (server-only).
//
//  brand_profiles: one row per project, the whole profile as JSONB
//  (it's an edited document, not queryable facts — JSONB keeps the
//  shape free to evolve without migrations).
//  brand_sources:  metadata about what was uploaded/fetched. Raw
//  source content is NOT stored — extraction is one-shot into the
//  profile, and the human-edited profile is the source of truth
//  afterwards (deleting a source therefore never mutates the
//  profile; the UI says so).
//
//  Same lazy idempotent-DDL pattern as lib/db/drafts.ts, and the
//  same mandatory Neon no-store option (Next's Data Cache would
//  otherwise serve stale profiles forever — see lib/db/client.ts).
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import {
  sanitizeBrandProfile,
  type BrandProfile,
  type BrandSourceMeta,
} from "./types";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let brandSchemaReady: Promise<void> | null = null;

export function ensureBrandSchema(): Promise<void> {
  if (!brandSchemaReady) {
    brandSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS brand_profiles (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL UNIQUE,
          profile    JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS brand_sources (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id UUID NOT NULL,
          kind       TEXT NOT NULL,
          name       TEXT NOT NULL,
          detail     TEXT NOT NULL DEFAULT '',
          status     TEXT NOT NULL DEFAULT 'done',
          error      TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_brand_sources_project
        ON brand_sources(project_id)
      `;
    })().catch((err) => {
      brandSchemaReady = null; // allow retry on transient failure
      throw err;
    });
  }
  return brandSchemaReady;
}

export async function getBrandProfile(
  projectId: string
): Promise<{ profile: BrandProfile; updatedAt: string } | null> {
  await ensureBrandSchema();
  const sql = db();
  const rows = await sql`
    SELECT profile, updated_at FROM brand_profiles WHERE project_id = ${projectId}
  `;
  if (!rows[0]) return null;
  return {
    profile: sanitizeBrandProfile(rows[0].profile),
    updatedAt: new Date(rows[0].updated_at as string).toISOString(),
  };
}

export async function saveBrandProfile(
  projectId: string,
  profile: BrandProfile
): Promise<void> {
  await ensureBrandSchema();
  const sql = db();
  const clean = sanitizeBrandProfile(profile);
  // ⚠️ No ON CONFLICT DO UPDATE here — the project's Neon setup hit 42P10 on
  // upsert once before (see the upsertScore postmortem); delete+insert is the
  // established safe pattern for single-row-per-key tables.
  await sql`DELETE FROM brand_profiles WHERE project_id = ${projectId}`;
  await sql`
    INSERT INTO brand_profiles (project_id, profile, updated_at)
    VALUES (${projectId}, ${JSON.stringify(clean)}::jsonb, NOW())
  `;
}

export async function listBrandSources(
  projectId: string
): Promise<BrandSourceMeta[]> {
  await ensureBrandSchema();
  const sql = db();
  const rows = await sql`
    SELECT id, kind, name, detail, status, error, created_at
    FROM brand_sources
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as BrandSourceMeta["kind"],
    name: String(r.name),
    detail: String(r.detail ?? ""),
    status: r.status === "error" ? "error" : "done",
    error: (r.error as string) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  }));
}

export async function insertBrandSource(input: {
  projectId: string;
  kind: BrandSourceMeta["kind"];
  name: string;
  detail: string;
  status: "done" | "error";
  error?: string | null;
}): Promise<BrandSourceMeta> {
  await ensureBrandSchema();
  const sql = db();
  const rows = await sql`
    INSERT INTO brand_sources (project_id, kind, name, detail, status, error)
    VALUES (${input.projectId}, ${input.kind}, ${input.name},
            ${input.detail}, ${input.status}, ${input.error ?? null})
    RETURNING id, created_at
  `;
  return {
    id: String(rows[0].id),
    kind: input.kind,
    name: input.name,
    detail: input.detail,
    status: input.status,
    error: input.error ?? null,
    createdAt: new Date(rows[0].created_at as string).toISOString(),
  };
}

export async function deleteBrandSource(
  projectId: string,
  sourceId: string
): Promise<void> {
  await ensureBrandSchema();
  const sql = db();
  await sql`
    DELETE FROM brand_sources WHERE id = ${sourceId} AND project_id = ${projectId}
  `;
}

/** Project-deletion cleanup — called from lib/db/projects.ts deleteProject. */
export async function deleteBrandDataForProject(projectId: string): Promise<void> {
  await ensureBrandSchema();
  const sql = db();
  await sql`DELETE FROM brand_profiles WHERE project_id = ${projectId}`;
  await sql`DELETE FROM brand_sources  WHERE project_id = ${projectId}`;
}
