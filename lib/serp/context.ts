// ─────────────────────────────────────────────────────────────
//  SERP scoring context — turns a page's latest stored Semrush
//  snapshot into a deterministic text block injected into the
//  scoring message (and therefore into the content hash).
//
//  Determinism: the block is built ONLY from stored snapshot rows
//  with stable sorting (volume desc, then text) — same snapshot ⇒
//  byte-identical block ⇒ identical content hash. A new snapshot
//  (new month's data) changes the block, which correctly forces a
//  versioned re-score instead of silently reusing a score judged
//  against stale questions. No snapshot ⇒ null ⇒ the model judges
//  paaCoverage against inferred questions (documented fallback).
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { ensureSerpSchema } from "@/lib/db/serp";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

const MAX_QUESTIONS = 12;
const MAX_KEYWORDS = 10;

/**
 * Build the verified-SERP context block for a page URL, or null when no
 * snapshot exists. Reads the LATEST snapshot for the URL regardless of
 * job — the monthly cache keeps its content stable within a month, so
 * simulate-now and audit-later see the same block.
 */
export async function getSerpScoringContext(pageUrl: string): Promise<string | null> {
  try {
    await ensureSerpSchema();
    const sql = db();
    const snaps = await sql`
      SELECT id, primary_keyword FROM serp_snapshots
      WHERE page_url = ${pageUrl}
      ORDER BY fetched_at DESC LIMIT 1
    `;
    if (snaps.length === 0) return null;
    const snapId = snaps[0].id as string;
    const primary = (snaps[0].primary_keyword as string) ?? null;

    const questions = await sql`
      SELECT question, volume FROM serp_questions
      WHERE snapshot_id = ${snapId}
      ORDER BY volume DESC, question ASC
      LIMIT ${MAX_QUESTIONS}
    `;
    const keywords = await sql`
      SELECT keyword, volume, aio_triggered, aio_cited, paa_present, paa_owned
      FROM serp_keywords
      WHERE snapshot_id = ${snapId} AND branded = FALSE
      ORDER BY volume DESC, keyword ASC
      LIMIT ${MAX_KEYWORDS}
    `;

    if (questions.length === 0 && keywords.length === 0 && !primary) return null;

    const lines: string[] = ["## Verified Search Context (from live Google SERP data)"];
    if (primary) lines.push(`Primary target query: ${primary}`);
    if (keywords.length > 0) {
      lines.push("Top ranked keywords (volume/mo · AI Overview on SERP? · this page cited in it? · PAA box? · this page owns a PAA answer?):");
      for (const k of keywords) {
        lines.push(
          `- ${k.keyword} (${k.volume}/mo · AIO ${k.aio_triggered ? "yes" : "no"} · cited ${k.aio_cited ? "yes" : "no"} · PAA ${k.paa_present ? "yes" : "no"} · owned ${k.paa_owned ? "yes" : "no"})`
        );
      }
    }
    if (questions.length > 0) {
      lines.push("Verified search questions (judge paaCoverage against THIS list):");
      for (const q of questions) {
        lines.push(`- ${q.question} (${q.volume}/mo)`);
      }
    }
    return lines.join("\n");
  } catch (err) {
    // Context is an enrichment, not a dependency — scoring must proceed
    // without it rather than fail. (Returning null keeps the hash stable
    // for the no-context case.)
    console.error(`[serp] context lookup failed for ${pageUrl}:`, err);
    return null;
  }
}
