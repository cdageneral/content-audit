// ─────────────────────────────────────────────────────────────
//  Per-URL search & AI visibility for the Optimize workbench.
//
//  Read-only over stored serp_* rows (DataForSEO/Semrush snapshots
//  captured at audit time) — this module makes ZERO provider calls
//  and never touches the scoring path. Every number it returns was
//  fetched from a live SERP at a known time; nothing is modeled.
//
//  Deliberately separate from lib/serp/context.ts: that block is
//  part of the scoring content hash and must stay byte-stable.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { ensureSerpSchema } from "@/lib/db/serp";
import { getPromptRowsForUrl } from "@/lib/db/prompts";
import { getKeywordPrefs } from "@/lib/db/keywordPrefs";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
  // no-store: Next caches the Neon driver's fetch reads otherwise.
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

export interface VisibilityKeyword {
  keyword: string;
  /**
   * Monthly search volume, or null when this snapshot predates the Semrush
   * per-keyword override (volumes_semrush = FALSE). Google-Ads volumes group
   * close variants — every variant inherits the cluster total — so those
   * numbers are not per-keyword facts and are never rendered as such.
   */
  volume: number | null;
  position: number;
  aioTriggered: boolean;
  aioCited: boolean;
  paaPresent: boolean;
  paaOwned: boolean;
  branded: boolean;
  /** Position in the previous snapshot of this URL, when one exists. */
  prevPosition: number | null;
  /**
   * TRUE when this keyword counts as a supporting term for the page —
   * explicit selection when prefs exist, else every non-branded ranked
   * keyword other than the head term.
   */
  supporting: boolean;
}

export interface PageVisibility {
  /** When the latest snapshot for this URL was fetched (ISO). */
  fetchedAt: string;
  /** Regional Google database the data came from (e.g. "us"). */
  database: string;
  /** Fetch time of the prior snapshot the deltas compare against (ISO), if any. */
  prevFetchedAt: string | null;
  /**
   * FALSE when this snapshot's volumes are the Google-Ads grouped figures. The
   * UI hides volume entirely in that case and says why.
   */
  volumesVerified: boolean;
  /**
   * The page's head term — the search query that matches its core intent.
   * Auto-derived (highest-volume non-branded ranked keyword; best rank when
   * volumes aren't trustworthy) unless a stored per-URL override selects a
   * different RANKED keyword.
   */
  headTerm: VisibilityKeyword | null;
  /** "override" when a stored pref picked the head term; else "auto". */
  headTermSource: "auto" | "override";
  /** Ranked keywords, volume desc (best rank first when volumes are unverified). */
  keywords: VisibilityKeyword[];
  /** Non-branded keywords whose SERP shows an AI Overview. */
  aioQueries: number;
  /** …of which the AI Overview cites THIS page. */
  aioCited: number;
  paaBoxes: number;
  paaOwned: number;
  /**
   * Open AI-visibility gaps: non-branded keywords where an AI Overview is
   * shown but this page is not cited — the optimization targets. Volume desc.
   */
  gaps: VisibilityKeyword[];
}

const MAX_KEYWORDS = 15;

/**
 * Latest stored visibility for a page URL (any job — latest snapshot that
 * actually carries keyword rows), with per-keyword position deltas vs the
 * prior snapshot of the same URL. Returns null when no data exists; callers
 * render an honest empty state instead of placeholders.
 */
export async function getPageVisibility(
  pageUrl: string,
  projectId?: string | null
): Promise<PageVisibility | null> {
  try {
    await ensureSerpSchema();
    const sql = db();

    const snaps = await sql`
      SELECT s.id, s.database, s.fetched_at, s.volumes_semrush FROM serp_snapshots s
      WHERE s.page_url = ${pageUrl}
        AND EXISTS (SELECT 1 FROM serp_keywords k WHERE k.snapshot_id = s.id)
      ORDER BY s.fetched_at DESC
      LIMIT 2
    `;
    if (snaps.length === 0) return null;
    const latest = snaps[0];
    const prior = snaps.length > 1 ? snaps[1] : null;

    // Grouped-era snapshots (pre-2026-07-25) carry Google Ads cluster totals,
    // not per-keyword volumes. Suppress the number rather than mislead.
    const volumesVerified = (latest.volumes_semrush as boolean) ?? false;

    const kws = await sql`
      SELECT keyword, position, volume, aio_triggered, aio_cited,
             paa_present, paa_owned, branded
      FROM serp_keywords WHERE snapshot_id = ${latest.id as string}
      ORDER BY keyword ASC
    `;

    const prevPos = new Map<string, number>();
    if (prior) {
      const prevRows = await sql`
        SELECT keyword, position FROM serp_keywords WHERE snapshot_id = ${prior.id as string}
      `;
      for (const r of prevRows) prevPos.set(r.keyword as string, r.position as number);
    }

    const all: VisibilityKeyword[] = kws.map((k) => ({
      keyword: k.keyword as string,
      volume: volumesVerified ? (k.volume as number) : null,
      position: k.position as number,
      aioTriggered: k.aio_triggered as boolean,
      aioCited: k.aio_cited as boolean,
      paaPresent: k.paa_present as boolean,
      paaOwned: k.paa_owned as boolean,
      branded: k.branded as boolean,
      prevPosition: prevPos.get(k.keyword as string) ?? null,
      supporting: false, // assigned below once the head term is known
    }));

    // Volume desc when the volumes are real per-keyword numbers; best organic
    // rank first when they aren't, so priority order never rests on a
    // grouped cluster total.
    all.sort((a, b) =>
      volumesVerified
        ? (b.volume ?? 0) - (a.volume ?? 0) || a.keyword.localeCompare(b.keyword)
        : a.position - b.position || a.keyword.localeCompare(b.keyword)
    );

    const nonBranded = all.filter((k) => !k.branded);
    // Head term: top non-branded ranked keyword under the sort above; if every
    // ranked keyword is branded, fall back to the top branded one (still real
    // data — the branded flag stays visible in the UI).
    let headTerm = nonBranded[0] ?? all[0] ?? null;
    let headTermSource: "auto" | "override" = "auto";

    // Stored per-URL prefs (project-scoped): the override can only SELECT a
    // keyword that exists in this snapshot — a pref pointing at a term the
    // page no longer ranks for silently falls back to auto, because there is
    // no verified data to show for it.
    const prefs = projectId ? await getKeywordPrefs(projectId, pageUrl) : null;
    if (prefs?.headTerm) {
      const chosen = all.find(
        (k) => k.keyword.toLowerCase() === prefs.headTerm!.toLowerCase()
      );
      if (chosen) {
        headTerm = chosen;
        headTermSource = "override";
      }
    }

    // Supporting terms: explicit selection when prefs carry one, else every
    // non-branded ranked keyword other than the head term.
    const supportingSet = prefs?.supporting
      ? new Set(prefs.supporting.map((s) => s.toLowerCase()))
      : null;
    for (const k of all) {
      const isHead = headTerm !== null && k.keyword === headTerm.keyword;
      k.supporting = supportingSet
        ? !isHead && supportingSet.has(k.keyword.toLowerCase())
        : !isHead && !k.branded;
    }

    const gaps = nonBranded.filter((k) => k.aioTriggered && !k.aioCited);

    return {
      fetchedAt: new Date(latest.fetched_at as string).toISOString(),
      database: (latest.database as string) ?? "us",
      prevFetchedAt: prior ? new Date(prior.fetched_at as string).toISOString() : null,
      volumesVerified,
      headTerm,
      headTermSource,
      keywords: all.slice(0, MAX_KEYWORDS),
      aioQueries: nonBranded.filter((k) => k.aioTriggered).length,
      aioCited: nonBranded.filter((k) => k.aioCited).length,
      paaBoxes: nonBranded.filter((k) => k.paaPresent).length,
      paaOwned: nonBranded.filter((k) => k.paaOwned).length,
      gaps,
    };
  } catch (err) {
    // Enrichment, not a dependency — the workbench renders without it.
    console.error(`[serp] visibility lookup failed for ${pageUrl}:`, err);
    return null;
  }
}

/**
 * Server-side validation for target wiring: given keywords a client checked,
 * return only those that are REAL stored targets for this URL (the head term
 * or an open AIO gap), with their stored volume/position. Keeps the model
 * brief honest no matter what a client sends.
 */
export async function resolveVisibilityTargets(
  pageUrl: string,
  requested: string[],
  projectId?: string | null
): Promise<VisibilityKeyword[]> {
  if (requested.length === 0) return [];
  const vis = await getPageVisibility(pageUrl, projectId);
  if (!vis) return [];
  const wanted = new Set(requested.map((s) => s.trim().toLowerCase()).filter(Boolean));
  const pool: VisibilityKeyword[] = [...vis.gaps];
  if (vis.headTerm && !pool.some((k) => k.keyword === vis.headTerm!.keyword)) {
    pool.push(vis.headTerm);
  }
  // Supporting terms are legitimate targets too (URL-level model): any
  // stored ranked keyword marked supporting joins the selectable pool.
  for (const k of vis.keywords) {
    if (k.supporting && !pool.some((p) => p.keyword === k.keyword)) pool.push(k);
  }
  return pool.filter((k) => wanted.has(k.keyword.toLowerCase())).slice(0, 8);
}

/**
 * All keyword strings in the latest stored snapshot for a URL — the
 * validation universe for keyword-pref writes. Empty when no data exists.
 */
export async function listStoredKeywords(pageUrl: string): Promise<string[]> {
  try {
    await ensureSerpSchema();
    const sql = db();
    const snaps = await sql`
      SELECT s.id FROM serp_snapshots s
      WHERE s.page_url = ${pageUrl}
        AND EXISTS (SELECT 1 FROM serp_keywords k WHERE k.snapshot_id = s.id)
      ORDER BY s.fetched_at DESC
      LIMIT 1
    `;
    if (snaps.length === 0) return [];
    const rows = await sql`
      SELECT keyword FROM serp_keywords WHERE snapshot_id = ${snaps[0].id as string}
    `;
    return rows.map((r) => r.keyword as string);
  } catch (err) {
    console.error(`[serp] keyword list failed for ${pageUrl}:`, err);
    return [];
  }
}

// ── Combined SERP + LLM-prompt target resolution ─────────────

export interface ResolvedTargets {
  /** Real stored ranked-keyword targets (head term / uncited-AIO gaps). */
  serp: VisibilityKeyword[];
  /**
   * Real stored LLM prompts matched to this URL whose latest checks show a
   * citation gap (no engine cites the page). Text only — prompts carry no
   * volume figures by design.
   */
  prompts: string[];
}

/**
 * Server-side validation for ALL target wiring: whatever a client checked,
 * only strings that exist as REAL stored targets for this URL survive —
 * either a ranked-keyword target or a prompt from the project's Prompt Set.
 */
export async function resolveAllTargets(
  pageUrl: string,
  projectId: string | null,
  requested: string[]
): Promise<ResolvedTargets> {
  if (requested.length === 0) return { serp: [], prompts: [] };
  const wanted = new Set(requested.map((s) => s.trim().toLowerCase()).filter(Boolean));

  const serp = await resolveVisibilityTargets(pageUrl, requested, projectId).catch(
    () => [] as VisibilityKeyword[]
  );

  let prompts: string[] = [];
  try {
    const rows = await getPromptRowsForUrl(projectId, pageUrl);
    prompts = rows
      .filter((r) => {
        const checks = Object.values(r.checks);
        const cited = checks.some((c) => c && c.status === "ok" && c.cited);
        return !cited; // citation gap (or not yet checked) → valid target
      })
      .map((r) => r.prompt)
      .filter((p) => wanted.has(p.trim().toLowerCase()))
      .slice(0, 6);
  } catch {
    prompts = [];
  }
  return { serp, prompts };
}
