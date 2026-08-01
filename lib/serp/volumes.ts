// ─────────────────────────────────────────────────────────────
//  Verified per-keyword search volume sweep.
//
//  The scan pipeline stores keyword volumes exactly as DataForSEO Labs
//  returns them, which means Google Ads figures — and Google Ads reports
//  ONE cluster total shared by a keyword and every close variant of it.
//  Ten "cd rates" phrasings all read 165,000 on US Bank while their true
//  volumes ran from 110 to 135,000. Displaying one such number is
//  misleading; summing 859 of them into a "total demand" headline is
//  simply false. So the Rankings panel showed no volume at all.
//
//  This module replaces those numbers with per-keyword volumes from
//  DataForSEO's Search Volume endpoint and flags each corrected row
//  volume_verified = TRUE. Everything demand-related downstream reads
//  ONLY verified rows; an unverified row renders "—" and is excluded from
//  every total, exactly like an uncaptured rank.
//
//  Cost control, in order of effect:
//   1. keyword_volumes cache (keyword + locale, monthly TTL) — a keyword is
//      paid for once across every project and scan inside the window.
//   2. 1000 keywords per request, so a 200-page scan needs ~2 calls.
//   3. A per-job spend ceiling that stops the sweep rather than the scan.
//
//  Never throws: a failed sweep leaves rows unverified, which the UI
//  already renders honestly. It must not fail (or retry) a webhook batch.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import {
  DFS_VOLUME_BATCH,
  dfsConfigured,
  fetchSearchVolumesDfs,
  volumeQueryable,
} from "@/lib/serp/dataforseo";
import { recordApiCall } from "@/lib/usage/record";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

/** Cache TTL in days. Search volume is a monthly figure; 30 days matches it. */
const VOLUME_TTL_DAYS = parseInt(process.env.SERP_VOLUME_TTL_DAYS ?? "30", 10);
/** Hard ceiling on volume spend per job, in USD (DataForSEO reports real cost). */
const VOLUME_COST_CAP_USD = parseFloat(process.env.SERP_VOLUME_COST_CAP_USD ?? "3");

export interface VolumeSweepResult {
  /** Keywords that needed a figure when the sweep started. */
  requested: number;
  /** …of those, served from the cross-project cache at no cost. */
  fromCache: number;
  /** …of those, fetched from the provider. */
  fetched: number;
  /** serp_keywords rows updated to a verified volume. */
  rowsUpdated: number;
  costUsd: number;
  /** TRUE when the spend ceiling stopped the sweep before it finished. */
  cappedOut: boolean;
}

const EMPTY: VolumeSweepResult = {
  requested: 0,
  fromCache: 0,
  fetched: 0,
  rowsUpdated: 0,
  costUsd: 0,
  cappedOut: false,
};

/**
 * Give every not-yet-verified keyword in a job's SERP snapshots a real
 * per-keyword volume. Idempotent: rows already verified are skipped, so
 * running this after each SERP batch converges without re-spending.
 */
export async function sweepJobVolumes(
  jobId: string,
  database: string
): Promise<VolumeSweepResult> {
  if (!dfsConfigured()) return EMPTY;
  const sql = db();

  // Keywords in this job that still carry an unverified (grouped) volume.
  const pending = await sql`
    SELECT DISTINCT LOWER(TRIM(k.keyword)) AS keyword
    FROM serp_keywords k
    JOIN serp_snapshots s ON s.id = k.snapshot_id
    WHERE s.job_id = ${jobId} AND k.volume_verified = FALSE
  `.catch(() => [] as Record<string, unknown>[]);

  const wanted = pending
    .map((r) => String(r.keyword ?? ""))
    .filter((k) => k.length > 0 && volumeQueryable(k));
  if (wanted.length === 0) return EMPTY;

  const out: VolumeSweepResult = { ...EMPTY, requested: wanted.length };

  // ── 1. Cache pass ───────────────────────────────────────────
  const cached = await sql`
    SELECT keyword, volume FROM keyword_volumes
    WHERE database = ${database}
      AND keyword = ANY(${wanted})
      AND fetched_at > NOW() - (${VOLUME_TTL_DAYS} * INTERVAL '1 day')
  `.catch(() => [] as Record<string, unknown>[]);

  const known = new Map<string, number>();
  for (const r of cached) {
    known.set(String(r.keyword), Number(r.volume ?? 0) || 0);
  }
  out.fromCache = known.size;

  // ── 2. Provider pass for whatever the cache didn't cover ────
  const missing = wanted.filter((k) => !known.has(k));
  for (let i = 0; i < missing.length; i += DFS_VOLUME_BATCH) {
    if (out.costUsd >= VOLUME_COST_CAP_USD) {
      out.cappedOut = true;
      console.warn(
        `[volumes] Job ${jobId}: volume spend cap $${VOLUME_COST_CAP_USD} reached — ` +
          `${missing.length - i} keyword(s) left unverified.`
      );
      break;
    }
    const chunk = missing.slice(i, i + DFS_VOLUME_BATCH);
    try {
      const res = await fetchSearchVolumesDfs(chunk, database);
      out.costUsd += res.costUsd;
      out.fetched += res.volumes.size;
      res.volumes.forEach((v, k) => known.set(k, v));

      await recordApiCall({
        provider: "dataforseo",
        purpose: "kw_volumes",
        costUsd: res.costUsd,
        jobId,
        meta: { database, requested: chunk.length, returned: res.volumes.size },
      });

      // Persist to the cross-project cache. Values are upserted so a refresh
      // of an aged row replaces it rather than accumulating duplicates.
      for (const [kw, vol] of Array.from(res.volumes.entries())) {
        await sql`
          INSERT INTO keyword_volumes (keyword, database, volume, source, fetched_at)
          VALUES (${kw}, ${database}, ${vol}, 'dfs_search_volume', NOW())
          ON CONFLICT (keyword, database)
          DO UPDATE SET volume = EXCLUDED.volume,
                        source = EXCLUDED.source,
                        fetched_at = EXCLUDED.fetched_at
        `.catch(() => undefined);
      }
    } catch (err) {
      // A bad chunk must not cost the rest of the sweep.
      console.error(`[volumes] Job ${jobId}: volume fetch failed for a chunk:`, err);
    }
  }

  if (known.size === 0) return out;

  // ── 3. Write verified volumes back onto this job's rows ─────
  const entries = Array.from(known.entries());
  for (let i = 0; i < entries.length; i += 500) {
    const slice = entries.slice(i, i + 500);
    const keys = slice.map((e) => e[0]);
    const vals = slice.map((e) => e[1]);
    const res = await sql`
      UPDATE serp_keywords k
      SET volume = v.volume, volume_verified = TRUE
      FROM (
        SELECT UNNEST(${keys}::text[]) AS keyword,
               UNNEST(${vals}::int[])  AS volume
      ) v
      WHERE LOWER(TRIM(k.keyword)) = v.keyword
        AND k.snapshot_id IN (SELECT id FROM serp_snapshots WHERE job_id = ${jobId})
        AND k.volume_verified = FALSE
      RETURNING k.id
    `.catch(() => [] as Record<string, unknown>[]);
    out.rowsUpdated += res.length;
  }

  await sql`
    UPDATE serp_snapshots s SET volumes_verified = TRUE
    WHERE s.job_id = ${jobId}
      AND EXISTS (
        SELECT 1 FROM serp_keywords k
        WHERE k.snapshot_id = s.id AND k.volume_verified = TRUE
      )
  `.catch(() => undefined);

  console.log(
    `[volumes] Job ${jobId}: ${out.rowsUpdated} row(s) verified — ` +
      `${out.fromCache} cached, ${out.fetched} fetched, $${out.costUsd.toFixed(4)}.`
  );
  return out;
}
