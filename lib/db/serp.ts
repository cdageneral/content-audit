// ─────────────────────────────────────────────────────────────
//  SERP visibility storage — snapshots of verified Semrush data
//  per (page, job). Lazy idempotent DDL like ensureOptimizeSchema;
//  FK-free so a not-yet-created table can never break deletes
//  (cleanup is best-effort in deleteProject, same as page_drafts).
//
//  Monthly cache: Semrush organic data refreshes ~monthly, so a
//  snapshot fetched for the same URL + database in the same
//  calendar month is copied instead of re-fetched (0 API units) —
//  the same reuse philosophy as content-hash score reuse.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import type { SerpKeywordRow, SerpQuestionRow } from "@/lib/serp/semrush";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

let serpSchemaReady: Promise<void> | null = null;

export function ensureSerpSchema(): Promise<void> {
  if (!serpSchemaReady) {
    serpSchemaReady = (async () => {
      const sql = db();
      await sql`
        CREATE TABLE IF NOT EXISTS serp_snapshots (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id      UUID NOT NULL,
          job_id          UUID NOT NULL,
          page_id         UUID NOT NULL,
          page_url        TEXT NOT NULL,
          database        TEXT NOT NULL,
          primary_keyword TEXT,
          keyword_count   INTEGER NOT NULL DEFAULT 0,
          units_spent     INTEGER NOT NULL DEFAULT 0,
          reused_from     UUID,
          fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_serp_snapshots_job ON serp_snapshots(job_id)
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_serp_snapshots_url ON serp_snapshots(page_url, database, fetched_at DESC)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS serp_keywords (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id     UUID NOT NULL,
          keyword         TEXT NOT NULL,
          position        INTEGER NOT NULL DEFAULT 0,
          volume          INTEGER NOT NULL DEFAULT 0,
          aio_triggered   BOOLEAN NOT NULL DEFAULT FALSE,
          aio_cited       BOOLEAN NOT NULL DEFAULT FALSE,
          paa_present     BOOLEAN NOT NULL DEFAULT FALSE,
          paa_owned       BOOLEAN NOT NULL DEFAULT FALSE,
          position_type   TEXT,
          branded         BOOLEAN NOT NULL DEFAULT FALSE
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_serp_keywords_snapshot ON serp_keywords(snapshot_id)
      `;
      await sql`
        CREATE TABLE IF NOT EXISTS serp_questions (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id     UUID NOT NULL,
          question        TEXT NOT NULL,
          volume          INTEGER NOT NULL DEFAULT 0,
          covered         BOOLEAN NOT NULL DEFAULT FALSE
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_serp_questions_snapshot ON serp_questions(snapshot_id)
      `;
      // Which regional Google database a project's SERP data comes from
      // (e.g. CHIP → 'ca'). NULL falls back to SEMRUSH_DEFAULT_DATABASE.
      await sql`
        ALTER TABLE projects ADD COLUMN IF NOT EXISTS serp_database TEXT
      `;
    })();
  }
  return serpSchemaReady;
}

// ── Writes ────────────────────────────────────────────────────

export interface SnapshotInput {
  projectId: string;
  jobId: string;
  pageId: string;
  pageUrl: string;
  database: string;
  primaryKeyword: string | null;
  unitsSpent: number;
  reusedFrom?: string | null;
  keywords: (SerpKeywordRow & { branded: boolean })[];
  questions: (SerpQuestionRow & { covered: boolean })[];
}

export async function insertSnapshot(input: SnapshotInput): Promise<string> {
  await ensureSerpSchema();
  const sql = db();
  // Idempotent per (page, job): QStash retries must not duplicate rows.
  const existing = await sql`
    SELECT id FROM serp_snapshots WHERE job_id = ${input.jobId} AND page_id = ${input.pageId}
  `;
  if (existing.length > 0) return existing[0].id as string;

  const snap = await sql`
    INSERT INTO serp_snapshots
      (project_id, job_id, page_id, page_url, database, primary_keyword, keyword_count, units_spent, reused_from)
    VALUES
      (${input.projectId}, ${input.jobId}, ${input.pageId}, ${input.pageUrl},
       ${input.database}, ${input.primaryKeyword}, ${input.keywords.length},
       ${input.unitsSpent}, ${input.reusedFrom ?? null})
    RETURNING id
  `;
  const snapshotId = snap[0].id as string;

  for (const k of input.keywords) {
    await sql`
      INSERT INTO serp_keywords
        (snapshot_id, keyword, position, volume, aio_triggered, aio_cited, paa_present, paa_owned, position_type, branded)
      VALUES
        (${snapshotId}, ${k.keyword}, ${k.position}, ${k.volume}, ${k.aioTriggered},
         ${k.aioCited}, ${k.paaPresent}, ${k.paaOwned}, ${k.positionType || null}, ${k.branded})
    `;
  }
  for (const q of input.questions) {
    await sql`
      INSERT INTO serp_questions (snapshot_id, question, volume, covered)
      VALUES (${snapshotId}, ${q.question}, ${q.volume}, ${q.covered})
    `;
  }
  return snapshotId;
}

// ── Monthly cache lookup ──────────────────────────────────────

export interface CachedSnapshot {
  id: string;
  primaryKeyword: string | null;
  keywords: (SerpKeywordRow & { branded: boolean })[];
  questions: (SerpQuestionRow & { covered: boolean })[];
}

/** Latest snapshot for this URL+database fetched in the current calendar month. */
export async function findMonthlySnapshot(
  pageUrl: string,
  database: string
): Promise<CachedSnapshot | null> {
  await ensureSerpSchema();
  const sql = db();
  const snaps = await sql`
    SELECT id, primary_keyword FROM serp_snapshots
    WHERE page_url = ${pageUrl} AND database = ${database}
      AND date_trunc('month', fetched_at) = date_trunc('month', NOW())
    ORDER BY fetched_at DESC LIMIT 1
  `;
  if (snaps.length === 0) return null;
  const id = snaps[0].id as string;
  const kws = await sql`SELECT * FROM serp_keywords WHERE snapshot_id = ${id}`;
  const qs = await sql`SELECT * FROM serp_questions WHERE snapshot_id = ${id}`;
  return {
    id,
    primaryKeyword: (snaps[0].primary_keyword as string) ?? null,
    keywords: kws.map((k) => ({
      keyword: k.keyword as string,
      position: k.position as number,
      volume: k.volume as number,
      url: pageUrl,
      triggeredFeatures: [],
      positionFeatures: [],
      positionType: (k.position_type as string) ?? "",
      aioTriggered: k.aio_triggered as boolean,
      aioCited: k.aio_cited as boolean,
      paaPresent: k.paa_present as boolean,
      paaOwned: k.paa_owned as boolean,
      branded: k.branded as boolean,
    })),
    questions: qs.map((q) => ({
      question: q.question as string,
      volume: q.volume as number,
      covered: q.covered as boolean,
    })),
  };
}

// ── Hub rollup read (Layer A math — deterministic, no model) ──

export interface SerpRollup {
  fetchedAt: string;
  database: string;
  pagesWithData: number;
  pagesTotal: number;
  // volume-weighted counts across non-branded keywords
  aioTriggeredKws: number;
  aioCitedKws: number;
  paaPresentKws: number;
  paaOwnedKws: number;
  questionsTotal: number;
  questionsCovered: number;
  moneyList: {
    keyword: string;
    volume: number;
    position: number;
    pageUrl: string;
  }[];
  citedList: { keyword: string; volume: number; pageUrl: string }[];
}

/** Aggregate the latest client job's snapshots for the hub card. */
export async function getSerpRollup(jobId: string): Promise<SerpRollup | null> {
  await ensureSerpSchema();
  const sql = db();
  const snaps = await sql`
    SELECT id, page_url, database, fetched_at FROM serp_snapshots WHERE job_id = ${jobId}
  `.catch(() => [] as Record<string, unknown>[]);
  if (snaps.length === 0) return null;

  const snapIds = snaps.map((s) => s.id as string);
  const urlBySnap = new Map(snaps.map((s) => [s.id as string, s.page_url as string]));

  const kws = await sql`
    SELECT snapshot_id, keyword, position, volume, aio_triggered, aio_cited,
           paa_present, paa_owned, branded
    FROM serp_keywords WHERE snapshot_id = ANY(${snapIds})
  `;
  const qs = await sql`
    SELECT covered FROM serp_questions WHERE snapshot_id = ANY(${snapIds})
  `;

  const nonBranded = kws.filter((k) => !k.branded);
  const moneyList = nonBranded
    .filter((k) => k.aio_triggered && !k.aio_cited)
    .map((k) => ({
      keyword: k.keyword as string,
      volume: k.volume as number,
      position: k.position as number,
      pageUrl: urlBySnap.get(k.snapshot_id as string) ?? "",
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15);
  const citedList = nonBranded
    .filter((k) => k.aio_cited)
    .map((k) => ({
      keyword: k.keyword as string,
      volume: k.volume as number,
      pageUrl: urlBySnap.get(k.snapshot_id as string) ?? "",
    }))
    .sort((a, b) => b.volume - a.volume)
    .slice(0, 15);

  return {
    fetchedAt: String(snaps[0].fetched_at),
    database: String(snaps[0].database),
    pagesWithData: snaps.length,
    pagesTotal: snaps.length,
    aioTriggeredKws: nonBranded.filter((k) => k.aio_triggered).length,
    aioCitedKws: nonBranded.filter((k) => k.aio_cited).length,
    paaPresentKws: nonBranded.filter((k) => k.paa_present).length,
    paaOwnedKws: nonBranded.filter((k) => k.paa_owned).length,
    questionsTotal: qs.length,
    questionsCovered: qs.filter((q) => q.covered).length,
    moneyList,
    citedList,
  };
}

/** Latest client job (done) that has snapshots, for a project. */
export async function getLatestSerpJobId(projectId: string): Promise<string | null> {
  await ensureSerpSchema();
  const sql = db();
  const rows = await sql`
    SELECT s.job_id
    FROM serp_snapshots s
    JOIN audit_jobs j ON j.id = s.job_id
    WHERE s.project_id = ${projectId} AND j.competitor_id IS NULL
    ORDER BY s.fetched_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  return rows.length > 0 ? (rows[0].job_id as string) : null;
}
