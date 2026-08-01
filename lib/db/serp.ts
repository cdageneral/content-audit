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
      // ── DataForSEO-era additions (2026-07) ─────────────────
      // Verbatim PAA questions carry the answering page (live SERP data).
      await sql`
        ALTER TABLE serp_questions ADD COLUMN IF NOT EXISTS source_url TEXT
      `;
      await sql`
        ALTER TABLE serp_questions ADD COLUMN IF NOT EXISTS source_domain TEXT
      `;
      // Actual provider spend in USD (DataForSEO returns real cost per call).
      await sql`
        ALTER TABLE serp_snapshots ADD COLUMN IF NOT EXISTS cost_usd REAL NOT NULL DEFAULT 0
      `;
      // Who occupies the AI Overview (feature 52) / answers the PAA box
      // (feature 21) for a scraped keyword — the "who is winning it" data.
      await sql`
        CREATE TABLE IF NOT EXISTS serp_occupants (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id UUID NOT NULL,
          keyword     TEXT NOT NULL,
          feature     SMALLINT NOT NULL,
          rank        INTEGER NOT NULL DEFAULT 0,
          domain      TEXT NOT NULL,
          url         TEXT,
          title       TEXT,
          is_client   BOOLEAN NOT NULL DEFAULT FALSE
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_serp_occupants_snapshot ON serp_occupants(snapshot_id)
      `;
      // Volume-source marker (2026-07-25): TRUE = keyword volumes were
      // replaced with Semrush per-keyword numbers (Google Ads groups close
      // variants, inflating every variant to the cluster total). Old
      // snapshots stay FALSE so the monthly cache won't pin grouped volumes.
      await sql`
        ALTER TABLE serp_snapshots ADD COLUMN IF NOT EXISTS volumes_semrush BOOLEAN NOT NULL DEFAULT FALSE
      `;
      // ── Verified per-keyword volume (2026-08-01) ───────────
      // Row-level truth marker. The Semrush override marked a whole snapshot
      // verified even when the provider returned no figure for some of its
      // keywords — those rows silently kept their Google-Ads GROUPED volume
      // while presenting as verified. Tolerable for one displayed number,
      // fatal for a SUM, so demand totals count only rows flagged here.
      await sql`
        ALTER TABLE serp_keywords ADD COLUMN IF NOT EXISTS volume_verified BOOLEAN NOT NULL DEFAULT FALSE
      `;
      // Snapshot-level convenience marker: at least one of my keyword rows
      // carries a verified per-keyword volume.
      await sql`
        ALTER TABLE serp_snapshots ADD COLUMN IF NOT EXISTS volumes_verified BOOLEAN NOT NULL DEFAULT FALSE
      `;
      // Cross-project keyword volume cache. Search volume is a property of
      // the keyword and locale, not of the page that ranks for it, so the
      // same keyword is never paid for twice inside the TTL — the second
      // scan of a site spends almost nothing on volume calls.
      await sql`
        CREATE TABLE IF NOT EXISTS keyword_volumes (
          keyword     TEXT NOT NULL,
          database    TEXT NOT NULL,
          volume      INTEGER NOT NULL,
          source      TEXT NOT NULL,
          fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (keyword, database)
        )
      `;
      await sql`
        CREATE INDEX IF NOT EXISTS idx_keyword_volumes_fetched ON keyword_volumes(fetched_at DESC)
      `;
    })();
  }
  return serpSchemaReady;
}

// ── Writes ────────────────────────────────────────────────────

export interface OccupantInput {
  keyword: string;
  feature: number; // 52 = AI Overview, 21 = PAA
  rank: number;
  domain: string;
  url?: string;
  title?: string;
  isClient: boolean;
}

export interface SnapshotInput {
  projectId: string;
  jobId: string;
  pageId: string;
  pageUrl: string;
  database: string;
  primaryKeyword: string | null;
  unitsSpent: number;
  costUsd?: number;
  reusedFrom?: string | null;
  /** TRUE when keyword volumes are Semrush per-keyword numbers. */
  volumesSemrush?: boolean;
  keywords: (SerpKeywordRow & { branded: boolean })[];
  questions: (SerpQuestionRow & { covered: boolean; sourceUrl?: string; sourceDomain?: string })[];
  occupants?: OccupantInput[];
}

export async function insertSnapshot(input: SnapshotInput): Promise<string> {
  await ensureSerpSchema();
  const sql = db();
  // Replace semantics (upsertScore pattern): "Refresh SERP data" on the same
  // job must overwrite the prior snapshot, not silently no-op — otherwise a
  // job whose first pass stored bad/empty data can never be corrected.
  // Delete-then-insert keeps QStash retries duplicate-free all the same.
  const existing = await sql`
    SELECT id FROM serp_snapshots WHERE job_id = ${input.jobId} AND page_id = ${input.pageId}
  `;
  for (const row of existing) {
    const oldId = row.id as string;
    await sql`DELETE FROM serp_keywords WHERE snapshot_id = ${oldId}`;
    await sql`DELETE FROM serp_questions WHERE snapshot_id = ${oldId}`;
    await sql`DELETE FROM serp_occupants WHERE snapshot_id = ${oldId}`.catch(() => undefined);
    await sql`DELETE FROM serp_snapshots WHERE id = ${oldId}`;
  }

  const snap = await sql`
    INSERT INTO serp_snapshots
      (project_id, job_id, page_id, page_url, database, primary_keyword, keyword_count, units_spent, cost_usd, reused_from, volumes_semrush)
    VALUES
      (${input.projectId}, ${input.jobId}, ${input.pageId}, ${input.pageUrl},
       ${input.database}, ${input.primaryKeyword}, ${input.keywords.length},
       ${input.unitsSpent}, ${input.costUsd ?? 0}, ${input.reusedFrom ?? null},
       ${input.volumesSemrush ?? false})
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
      INSERT INTO serp_questions (snapshot_id, question, volume, covered, source_url, source_domain)
      VALUES (${snapshotId}, ${q.question}, ${q.volume}, ${q.covered},
              ${q.sourceUrl ?? null}, ${q.sourceDomain ?? null})
    `;
  }
  for (const o of input.occupants ?? []) {
    await sql`
      INSERT INTO serp_occupants (snapshot_id, keyword, feature, rank, domain, url, title, is_client)
      VALUES (${snapshotId}, ${o.keyword}, ${o.feature}, ${o.rank}, ${o.domain},
              ${o.url ?? null}, ${o.title ?? null}, ${o.isClient})
    `;
  }
  return snapshotId;
}

// ── Monthly cache lookup ──────────────────────────────────────

export interface CachedSnapshot {
  id: string;
  primaryKeyword: string | null;
  volumesSemrush: boolean;
  keywords: (SerpKeywordRow & { branded: boolean })[];
  questions: (SerpQuestionRow & { covered: boolean; sourceUrl?: string; sourceDomain?: string })[];
  occupants: OccupantInput[];
}

/** Latest snapshot for this URL+database fetched in the current calendar month. */
export async function findMonthlySnapshot(
  pageUrl: string,
  database: string
): Promise<CachedSnapshot | null> {
  await ensureSerpSchema();
  const sql = db();
  // Only reuse snapshots that actually carry keyword rows: an empty snapshot
  // is either a fetch bug (e.g. the pre-variant-retry URL-mismatch era) or a
  // page that ranks for nothing — both are worth re-checking rather than
  // pinning a zero for the rest of the month (an empty Labs call is cheap).
  // volumes_semrush = TRUE required: snapshots from the Google-Ads-grouped
  // era must not be pinned for the rest of the month — one fresh fetch
  // replaces them with per-keyword volumes, then caching resumes.
  const snaps = await sql`
    SELECT s.id, s.primary_keyword, s.volumes_semrush FROM serp_snapshots s
    WHERE s.page_url = ${pageUrl} AND s.database = ${database}
      AND date_trunc('month', s.fetched_at) = date_trunc('month', NOW())
      AND s.volumes_semrush = TRUE
      AND EXISTS (SELECT 1 FROM serp_keywords k WHERE k.snapshot_id = s.id)
    ORDER BY s.fetched_at DESC LIMIT 1
  `;
  if (snaps.length === 0) return null;
  const id = snaps[0].id as string;
  const kws = await sql`SELECT * FROM serp_keywords WHERE snapshot_id = ${id}`;
  const qs = await sql`SELECT * FROM serp_questions WHERE snapshot_id = ${id}`;
  const occ = await sql`SELECT * FROM serp_occupants WHERE snapshot_id = ${id}`.catch(
    () => [] as Record<string, unknown>[]
  );
  return {
    id,
    primaryKeyword: (snaps[0].primary_keyword as string) ?? null,
    volumesSemrush: (snaps[0].volumes_semrush as boolean) ?? false,
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
      sourceUrl: (q.source_url as string) ?? undefined,
      sourceDomain: (q.source_domain as string) ?? undefined,
    })),
    occupants: occ.map((o) => ({
      keyword: o.keyword as string,
      feature: o.feature as number,
      rank: o.rank as number,
      domain: o.domain as string,
      url: (o.url as string) ?? undefined,
      title: (o.title as string) ?? undefined,
      isClient: o.is_client as boolean,
    })),
  };
}

// ── Hub rollup read (Layer A math — deterministic, no model) ──

export interface SerpRollup {
  fetchedAt: string;
  database: string;
  /** URLs where at least one non-branded keyword triggers an AIO or PAA box. */
  urlsWithFeatures: number;
  /** URLs that have a stored snapshot in this run (features or not). */
  urlsWithData: number;
  /** AI Overviews triggered across non-branded ranked keywords. */
  aioTriggeredKws: number;
  /** …of which the AI Overview cites one of the client's URLs. */
  aioCitedKws: number;
  /**
   * Distinct People-Also-Ask questions captured from LIVE SERP scrapes,
   * deduped by question text.
   *
   * Deliberately question-level, not keyword-level (2026-07-26). PAA
   * ownership can only be determined from a live scrape — DataForSEO's bulk
   * ranked-keywords endpoint returns actual result elements only for
   * organic/paid/featured_snippet/local_pack, so it can never say who answers
   * a PAA box. Counting boxes from the bulk flag while sourcing owners from
   * the live scrape mixed a complete denominator with a partial numerator and
   * structurally understated ownership. Both numbers now come from the same
   * verified set.
   */
  paaQuestionsTotal: number;
  /** …of which one of the client's URLs is the named answer source. */
  paaQuestionsOwned: number;
  /**
   * Keywords whose AI Overview already cites a page of the client's — name
   * only. No volume figure: see the volume-honesty note on getSerpRollup.
   */
  citedList: { keyword: string; pageUrl: string }[];
}

/**
 * Aggregate the latest client job's snapshots for the hub card.
 *
 * Volume honesty (2026-07-26): the hub deliberately carries NO per-keyword
 * volume numbers. Snapshots taken before the Semrush override (2026-07-25)
 * store Google-Ads *grouped* volumes, where every close variant inherits the
 * cluster total — "best savings account high-yield" read 1,000,000 against a
 * true 20/mo. Those numbers also mis-ordered any "biggest misses" ranking, so
 * the ranked table was removed rather than shown with a caveat. Volume is
 * surfaced only in the Optimize workbench, and only when the snapshot is
 * marked volumes_semrush = TRUE.
 */
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
  // PAA questions actually captured from live SERPs (feature 21), with the
  // is_client flag DataForSEO's answer source resolved to.
  const paaOcc = await sql`
    SELECT title, is_client FROM serp_occupants
    WHERE snapshot_id = ANY(${snapIds}) AND feature = 21
  `.catch(() => [] as Record<string, unknown>[]);

  const nonBranded = kws.filter((k) => !k.branded);

  // Dedupe by question text — the same PAA question surfaces on several
  // keywords and pages. Owned when ANY captured instance names a client URL.
  const paaByQuestion = new Map<string, boolean>();
  for (const o of paaOcc) {
    const q = String(o.title ?? "").trim().toLowerCase();
    if (!q) continue;
    paaByQuestion.set(q, (paaByQuestion.get(q) ?? false) || Boolean(o.is_client));
  }
  let paaQuestionsOwned = 0;
  paaByQuestion.forEach((owned) => {
    if (owned) paaQuestionsOwned++;
  });

  // URLs with a SERP feature in play: at least one non-branded keyword that
  // triggers an AI Overview or shows a PAA box.
  const featureUrls = new Set<string>();
  for (const k of nonBranded) {
    if (!k.aio_triggered && !k.paa_present) continue;
    const u = urlBySnap.get(k.snapshot_id as string);
    if (u) featureUrls.add(u.toLowerCase());
  }
  // Cited-for list: alphabetical, not volume-ranked — a volume sort would
  // silently reintroduce the grouped-volume ordering bug.
  const citedList = nonBranded
    .filter((k) => k.aio_cited)
    .map((k) => ({
      keyword: k.keyword as string,
      pageUrl: urlBySnap.get(k.snapshot_id as string) ?? "",
    }))
    .sort((a, b) => a.keyword.localeCompare(b.keyword))
    .slice(0, 15);

  return {
    fetchedAt: String(snaps[0].fetched_at),
    database: String(snaps[0].database),
    urlsWithFeatures: featureUrls.size,
    urlsWithData: snaps.length,
    aioTriggeredKws: nonBranded.filter((k) => k.aio_triggered).length,
    aioCitedKws: nonBranded.filter((k) => k.aio_cited).length,
    paaQuestionsTotal: paaByQuestion.size,
    paaQuestionsOwned,
    citedList,
  };
}

// ── Per-URL summaries (All Pages table chips + drawer detail) ─

export interface SerpKeywordDetail {
  keyword: string;
  /**
   * Monthly search volume, or null when the snapshot's volumes are the
   * Google-Ads *grouped* figures (volumes_semrush = FALSE). Null renders as
   * "—" — never as a number we can't stand behind.
   */
  volume: number | null;
  position: number;
  aioTriggered: boolean;
  aioCited: boolean;
  paaPresent: boolean;
  paaOwned: boolean;
  branded: boolean;
  /** Non-client domains cited in this keyword's AI Overview (rank order). */
  aioWinners: string[];
  /** True when a DIFFERENT page of the client's site is cited (sibling win). */
  siblingCited: boolean;
}

export interface SerpPageSummary {
  primaryKeyword: string | null;
  aioTriggered: number;
  aioCited: number;
  paaPresent: number;
  paaOwned: number;
  /** Best organic position among non-branded ranked keywords (0 = none). */
  bestPosition: number;
  /** Non-branded keywords with an organic position captured (pre-slice). */
  rankedKeywords: number;
  keywords: SerpKeywordDetail[];
  questions: { question: string; covered: boolean; sourceDomain: string | null }[];
}

/**
 * Per-page-URL SERP summary for the latest job with snapshots. Client-host
 * matching uses the page URL's hostname, so a sibling page of the same site
 * appearing in the AI Overview is reported as siblingCited, not as a miss
 * by another brand.
 */
export async function getSerpPageSummaries(
  jobId: string
): Promise<Record<string, SerpPageSummary>> {
  await ensureSerpSchema();
  const sql = db();
  const out: Record<string, SerpPageSummary> = {};

  const snaps = await sql`
    SELECT id, page_url, primary_keyword, volumes_semrush
    FROM serp_snapshots WHERE job_id = ${jobId}
  `.catch(() => [] as Record<string, unknown>[]);
  if (snaps.length === 0) return out;
  const snapIds = snaps.map((x) => x.id as string);

  const kws = await sql`
    SELECT * FROM serp_keywords WHERE snapshot_id = ANY(${snapIds})
  `.catch(() => [] as Record<string, unknown>[]);
  const occs = await sql`
    SELECT * FROM serp_occupants WHERE snapshot_id = ANY(${snapIds}) ORDER BY rank ASC
  `.catch(() => [] as Record<string, unknown>[]);
  const qs = await sql`
    SELECT * FROM serp_questions WHERE snapshot_id = ANY(${snapIds})
  `.catch(() => [] as Record<string, unknown>[]);

  const occBySnapKw = new Map<string, Record<string, unknown>[]>();
  for (const o of occs) {
    const key = `${o.snapshot_id}|${o.keyword}|${o.feature}`;
    const arr = occBySnapKw.get(key) ?? [];
    arr.push(o);
    occBySnapKw.set(key, arr);
  }

  for (const snap of snaps) {
    const snapId = snap.id as string;
    const pageUrl = snap.page_url as string;
    let clientHost = "";
    try {
      clientHost = new URL(pageUrl).hostname.replace(/^www\./, "");
    } catch {
      /* keep empty */
    }

    // Volumes are only trustworthy per-keyword when this snapshot was written
    // with the Semrush override; grouped-era rows surface as null → "—".
    const volumesOk = (snap.volumes_semrush as boolean) ?? false;

    const rows = kws.filter((k) => k.snapshot_id === snapId);
    const details: SerpKeywordDetail[] = rows.map((k) => {
      const aioOcc = occBySnapKw.get(`${snapId}|${k.keyword}|52`) ?? [];
      const winners: string[] = [];
      let siblingCited = false;
      for (const o of aioOcc) {
        const dom = String(o.domain ?? "");
        if (o.is_client) {
          // Client present via a different URL than this page → sibling win
          if (!(k.aio_cited as boolean)) siblingCited = true;
          continue;
        }
        if (winners.length < 4 && winners.indexOf(dom) === -1) winners.push(dom);
      }
      return {
        keyword: k.keyword as string,
        volume: volumesOk ? (k.volume as number) : null,
        position: k.position as number,
        aioTriggered: k.aio_triggered as boolean,
        aioCited: k.aio_cited as boolean,
        paaPresent: k.paa_present as boolean,
        paaOwned: k.paa_owned as boolean,
        branded: k.branded as boolean,
        aioWinners: winners,
        siblingCited,
      };
    });
    // Volume desc when volumes are real; alphabetical when they aren't, so a
    // grouped-volume tie doesn't dictate a bogus priority order.
    details.sort((a, b) =>
      volumesOk
        ? (b.volume ?? 0) - (a.volume ?? 0)
        : a.keyword.localeCompare(b.keyword)
    );

    const nb = details.filter((d) => !d.branded);
    // Traditional-rank facts (2026-07-31): computed BEFORE the 15-row slice
    // so the Pages table can show the full picture, not the slice's.
    const nbRanked = nb.filter((d) => d.position > 0);
    out[pageUrl] = {
      primaryKeyword: (snap.primary_keyword as string) ?? null,
      aioTriggered: nb.filter((d) => d.aioTriggered).length,
      aioCited: nb.filter((d) => d.aioCited).length,
      paaPresent: nb.filter((d) => d.paaPresent).length,
      paaOwned: nb.filter((d) => d.paaOwned).length,
      bestPosition: nbRanked.length > 0 ? Math.min(...nbRanked.map((d) => d.position)) : 0,
      rankedKeywords: nbRanked.length,
      keywords: details.slice(0, 15),
      questions: qs
        .filter((q) => q.snapshot_id === snapId)
        .map((q) => ({
          question: q.question as string,
          covered: q.covered as boolean,
          sourceDomain: (q.source_domain as string) ?? null,
        })),
    };
    // clientHost currently informs is_client at write time; kept here for
    // future refinement without another schema pass.
    void clientHost;
  }
  return out;
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
