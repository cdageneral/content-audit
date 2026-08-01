// ─────────────────────────────────────────────────────────────
//  DataForSEO client — AIO / PAA visibility detection (primary
//  provider; the Semrush client remains as a fallback behind the
//  same row shape).
//
//  Two endpoints:
//   · Labs ranked_keywords (live): full-URL target → the keywords
//     this page ranks for, with volume, position, the SERP's
//     feature list (ai_overview / people_also_ask present), and —
//     via item_types — whether the page itself ranks as an
//     ai_overview_reference (= cited in the AI Overview).
//   · SERP organic live advanced: the LIVE SERP for a keyword →
//     the AI Overview's reference list (who is cited, in order)
//     and the verbatim People-Also-Ask questions, each with the
//     answering page's URL/domain.
//
//  Auth: HTTP Basic with DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
//  Cost: DataForSEO returns the charged cost on every response —
//  we pass it through so callers can enforce budget caps with
//  actual (not estimated) numbers.
//
//  Parsing is defensive throughout (optional chaining, empty-array
//  fallbacks): response shapes were built from the documented
//  schema and MUST be verified against a live response on first
//  activation before trusting edge cases.
// ─────────────────────────────────────────────────────────────

import type { SerpKeywordRow } from "@/lib/serp/semrush";

const API_BASE = "https://api.dataforseo.com/v3";
const FETCH_TIMEOUT_MS = 40_000;

export function dfsConfigured(): boolean {
  return !!process.env.DATAFORSEO_LOGIN && !!process.env.DATAFORSEO_PASSWORD;
}

// Google location/language codes per regional database key (same keys the
// project-level serp_database setting uses; extend as client geos appear).
const LOCATIONS: Record<string, { location_code: number; language_code: string }> = {
  us: { location_code: 2840, language_code: "en" },
  ca: { location_code: 2124, language_code: "en" },
  uk: { location_code: 2826, language_code: "en" },
  au: { location_code: 2036, language_code: "en" },
  de: { location_code: 2276, language_code: "de" },
  fr: { location_code: 2250, language_code: "fr" },
  es: { location_code: 2724, language_code: "es" },
  it: { location_code: 2380, language_code: "it" },
  nl: { location_code: 2528, language_code: "nl" },
  br: { location_code: 2076, language_code: "pt" },
  mx: { location_code: 2484, language_code: "es" },
  in: { location_code: 2356, language_code: "en" },
};

function locFor(database: string) {
  return LOCATIONS[database] ?? LOCATIONS.us;
}

// ── Low-level POST ────────────────────────────────────────────

interface DfsEnvelope {
  cost?: number;
  tasks?: {
    status_code?: number;
    status_message?: string;
    result?: unknown[];
  }[];
}

async function dfsPost(path: string, payload: Record<string, unknown>): Promise<{
  result: Record<string, unknown> | null;
  costUsd: number;
}> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DATAFORSEO credentials not set");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as DfsEnvelope;
    const task = data.tasks?.[0];
    if (!task || (task.status_code ?? 0) >= 40000) {
      // 40xxx = task-level errors (bad auth → 40100/40200-range, no money →
      // 40201 "Payment Required", etc.). Surface the real message.
      throw new Error(`DataForSEO task error: ${task?.status_code} ${task?.status_message ?? ""}`);
    }
    return {
      result: (task.result?.[0] as Record<string, unknown>) ?? null,
      costUsd: typeof data.cost === "number" ? data.cost : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Same POST, but returns the FULL result array instead of result[0].
 * The clickstream volume endpoint returns one result element per keyword,
 * so the single-element reader above would silently drop 999 of 1000 rows.
 */
async function dfsPostList(path: string, payload: Record<string, unknown>): Promise<{
  results: Record<string, unknown>[];
  costUsd: number;
}> {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DATAFORSEO credentials not set");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      signal: ctrl.signal,
      cache: "no-store",
      headers: {
        Authorization: `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([payload]),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`DataForSEO HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as DfsEnvelope;
    const task = data.tasks?.[0];
    if (!task || (task.status_code ?? 0) >= 40000) {
      throw new Error(`DataForSEO task error: ${task?.status_code} ${task?.status_message ?? ""}`);
    }
    return {
      results: (task.result as Record<string, unknown>[]) ?? [],
      costUsd: typeof data.cost === "number" ? data.cost : 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── Per-keyword search volume (DataForSEO Search Volume) ─────
//
//  WHY THIS EXISTS: Google Ads — and therefore DataForSEO Labs
//  keyword_info.search_volume — reports ONE cluster total shared by a
//  keyword and all its close variants. Proven on US Bank, where ten
//  distinct "cd rates" phrasings all displayed 165,000 while their real
//  volumes ranged from 110 to 135,000. Any sum, weighting, or ranking
//  built on those numbers is wrong, not merely imprecise.
//
//  keywords_data/clickstream_data/dataforseo_search_volume/live exists
//  specifically to un-group them: it normalises Google Ads volume with
//  clickstream (or Bing) data into a per-keyword figure.
//  Docs: https://docs.dataforseo.com/v3/keywords_data-clickstream_data-dataforseo_search_volume-live/
//  Limits: 1000 keywords/request, 12 requests/minute, $0.15 per task.

/** DataForSEO's hard cap on keywords per volume request. */
export const DFS_VOLUME_BATCH = 1000;

/**
 * DataForSEO fails the whole task if a keyword is malformed, so screen them
 * first: it caps keywords at 80 characters and 10 words and does not accept
 * most punctuation. A keyword that fails here is left unverified rather than
 * risking the batch it would have travelled in.
 */
export function volumeQueryable(keyword: string): boolean {
  const k = keyword.trim();
  if (k.length === 0 || k.length > 80) return false;
  if (k.split(/\s+/).length > 10) return false;
  return /^[a-z0-9 '&+./-]+$/i.test(k);
}

export interface DfsVolumeResult {
  /** lowercased keyword → monthly search volume (only keywords the API returned). */
  volumes: Map<string, number>;
  costUsd: number;
}

/**
 * Per-keyword monthly search volume for up to DFS_VOLUME_BATCH keywords in
 * one call. Keywords the API has no figure for are simply ABSENT from the
 * map — absent means "unknown", never zero.
 */
export async function fetchSearchVolumesDfs(
  keywords: string[],
  database: string
): Promise<DfsVolumeResult> {
  const loc = locFor(database);
  const clean = Array.from(
    new Set(keywords.map((k) => k.trim().toLowerCase()).filter(volumeQueryable))
  ).slice(0, DFS_VOLUME_BATCH);
  if (clean.length === 0) return { volumes: new Map(), costUsd: 0 };

  const { results, costUsd } = await dfsPostList(
    "/keywords_data/clickstream_data/dataforseo_search_volume/live",
    {
      keywords: clean,
      location_code: loc.location_code,
      language_code: loc.language_code,
    }
  );

  // ⚠️ SHAPE: this endpoint nests the keyword rows TWO levels down —
  // tasks[0].result[0].items[], where result[0] is a location/language
  // wrapper carrying items_count. Reading result[] as the row list costs a
  // real charge and silently returns zero volumes (that exact bug shipped
  // 2026-08-01 and billed $0.36 for nothing). Both shapes are accepted here
  // so a future response reshuffle degrades instead of going quiet.
  const volumes = new Map<string, number>();
  const items: Record<string, unknown>[] = [];
  for (const r of results) {
    const nested = r.items;
    if (Array.isArray(nested)) items.push(...(nested as Record<string, unknown>[]));
    else if (r.keyword !== undefined) items.push(r);
  }

  for (const it of items) {
    const kw = String(it.keyword ?? "").trim().toLowerCase();
    const sv = it.search_volume;
    // A null search_volume means "no data for this keyword". Storing it as 0
    // would assert nobody searches it — a different and unverified claim.
    if (!kw || typeof sv !== "number" || !Number.isFinite(sv)) continue;
    volumes.set(kw, Math.max(0, Math.round(sv)));
  }

  // A paid call that yields nothing is a bug signal, not a quiet no-op.
  if (volumes.size === 0) {
    console.error(
      `[volumes] DataForSEO returned ${results.length} result block(s) and ` +
        `${items.length} item(s) for ${clean.length} keyword(s) but produced NO usable ` +
        `volumes (charged $${costUsd.toFixed(4)}). First result keys: ` +
        `${JSON.stringify(Object.keys(results[0] ?? {}))}`
    );
  }
  return { volumes, costUsd };
}

// ── Keyword inventory (Labs ranked_keywords, full-URL target) ─

export interface DfsKeywordsResult {
  rows: SerpKeywordRow[];
  costUsd: number;
  /** The URL variant DataForSEO actually matched (may differ from input in www/trailing slash). */
  matchedUrl: string;
}

function toggleSlashDfs(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : `${url}/`;
}

function toggleWwwDfs(url: string): string {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.startsWith("www.")
      ? u.hostname.slice(4)
      : `www.${u.hostname}`;
    return u.toString().replace(/\/$/, url.endsWith("/") ? "/" : "");
  } catch {
    return url;
  }
}

/**
 * DataForSEO's Labs target is an EXACT page-URL match against its index —
 * "https://iquanti.com/careers" finds nothing when the site canonically
 * lives at "https://www.iquanti.com/careers/". Crawl-stored URLs and index
 * URLs routinely disagree on www and trailing slash, so try all four
 * combinations and stop at the first variant that returns rows.
 * (Verified live 2026-07-23: iquanti.com stored bare/no-slash, ranked
 * exclusively as www + slash — exact-match-only returned zero for 13/13.)
 */
function urlVariantsDfs(pageUrl: string): string[] {
  const withWwwToggled = toggleWwwDfs(pageUrl);
  const out = [
    pageUrl,
    toggleSlashDfs(pageUrl),
    withWwwToggled,
    toggleSlashDfs(withWwwToggled),
  ];
  return out.filter((v, i) => out.indexOf(v) === i);
}

// Per-host memo of which variant index matched last (module state survives
// across pages within a warm lambda / batch loop). Every Labs call is paid,
// so once one page on a host resolves — e.g. to www + trailing slash — all
// subsequent pages on that host try the winning shape first instead of
// burning up to 3 misses per page.
const hostVariantHint = new Map<string, number>();

export async function fetchUrlKeywordsDfs(
  pageUrl: string,
  database: string,
  limit: number
): Promise<DfsKeywordsResult> {
  const loc = locFor(database);
  const host = hostnameOf(pageUrl);
  const variants = urlVariantsDfs(pageUrl);
  const hint = hostVariantHint.get(host);
  const order =
    hint !== undefined && hint > 0 && hint < variants.length
      ? [variants[hint], ...variants.filter((_, i) => i !== hint)]
      : variants;
  let totalCost = 0;

  for (const variant of order) {
    const { rows, costUsd } = await fetchVariantKeywordsDfs(variant, loc, limit);
    totalCost += costUsd;
    if (rows.length > 0) {
      hostVariantHint.set(host, variants.indexOf(variant));
      return { rows, costUsd: totalCost, matchedUrl: variant };
    }
  }
  return { rows: [], costUsd: totalCost, matchedUrl: pageUrl };
}

async function fetchVariantKeywordsDfs(
  pageUrl: string,
  loc: { location_code: number; language_code: string },
  limit: number
): Promise<{ rows: SerpKeywordRow[]; costUsd: number }> {
  const { result, costUsd } = await dfsPost("/dataforseo_labs/google/ranked_keywords/live", {
    target: pageUrl,
    location_code: loc.location_code,
    language_code: loc.language_code,
    limit,
    order_by: ["keyword_data.keyword_info.search_volume,desc"],
    // organic gives position; ai_overview_reference rows mean THIS page is
    // cited inside the keyword's AI Overview.
    item_types: ["organic", "ai_overview_reference"],
  });

  const items = ((result?.items as unknown[]) ?? []) as Record<string, unknown>[];
  const byKeyword = new Map<string, SerpKeywordRow>();

  for (const item of items) {
    const kd = item.keyword_data as Record<string, unknown> | undefined;
    const keyword = String(kd?.keyword ?? "").trim();
    if (!keyword) continue;
    const volume = Number((kd?.keyword_info as Record<string, unknown>)?.search_volume ?? 0) || 0;
    const serpTypes = (((kd?.serp_info as Record<string, unknown>)?.serp_item_types as unknown[]) ?? []).map(String);
    const se = (item.ranked_serp_element as Record<string, unknown>)?.serp_item as
      | Record<string, unknown>
      | undefined;
    const elType = String(se?.type ?? "");
    const rank = Number(se?.rank_group ?? 0) || 0;

    const existing = byKeyword.get(keyword);
    const row: SerpKeywordRow = existing ?? {
      keyword,
      position: 0,
      volume,
      url: pageUrl,
      triggeredFeatures: [],
      positionFeatures: [],
      positionType: "",
      aioTriggered: serpTypes.indexOf("ai_overview") !== -1,
      aioCited: false,
      paaPresent: serpTypes.indexOf("people_also_ask") !== -1,
      paaOwned: false,
    };
    if (elType === "organic" && (row.position === 0 || rank < row.position)) {
      row.position = rank;
      row.positionType = "Organic";
    }
    if (elType === "ai_overview_reference") {
      row.aioCited = true;
    }
    byKeyword.set(keyword, row);
  }

  const rows: SerpKeywordRow[] = [];
  byKeyword.forEach((r) => rows.push(r));
  rows.sort((a, b) => b.volume - a.volume || (a.keyword < b.keyword ? -1 : 1));
  return { rows, costUsd };
}

// ── Live SERP (AIO references + verbatim PAA + organic top) ──

export interface AioReference {
  domain: string;
  url: string;
  title: string;
}

export interface PaaQuestionLive {
  question: string;
  sourceUrl: string;
  sourceDomain: string;
}

export interface DfsLiveSerp {
  aioPresent: boolean;
  aioRefs: AioReference[];
  paaQuestions: PaaQuestionLive[];
  organicTop: { rank: number; domain: string; url: string }[];
  costUsd: number;
}

/** Collect reference objects from an ai_overview item (top level + nested). */
function collectAioRefs(aio: Record<string, unknown>): AioReference[] {
  const out: AioReference[] = [];
  const seen = new Set<string>();
  const push = (r: unknown) => {
    const ref = r as Record<string, unknown>;
    const url = String(ref?.url ?? "");
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({
      url,
      domain: String(ref?.domain ?? hostnameOf(url)),
      title: String(ref?.title ?? ""),
    });
  };
  ((aio.references as unknown[]) ?? []).forEach(push);
  for (const sub of ((aio.items as unknown[]) ?? []) as Record<string, unknown>[]) {
    ((sub?.references as unknown[]) ?? []).forEach(push);
  }
  return out;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export async function fetchSerpLiveDfs(
  keyword: string,
  database: string
): Promise<DfsLiveSerp> {
  const loc = locFor(database);
  const { result, costUsd } = await dfsPost("/serp/google/organic/live/advanced", {
    keyword,
    location_code: loc.location_code,
    language_code: loc.language_code,
    depth: 20,
    // Google frequently loads the AI Overview asynchronously; this flag asks
    // DataForSEO to wait for / fetch it so the ai_overview item is populated.
    load_async_ai_overview: true,
  });

  const items = ((result?.items as unknown[]) ?? []) as Record<string, unknown>[];
  let aioPresent = false;
  let aioRefs: AioReference[] = [];
  const paaQuestions: PaaQuestionLive[] = [];
  const organicTop: { rank: number; domain: string; url: string }[] = [];

  for (const item of items) {
    const type = String(item.type ?? "");
    if (type === "ai_overview") {
      aioPresent = true;
      aioRefs = collectAioRefs(item);
    } else if (type === "people_also_ask") {
      for (const q of ((item.items as unknown[]) ?? []) as Record<string, unknown>[]) {
        const question = String(q?.title ?? "").trim();
        if (!question) continue;
        const exp = (((q?.expanded_element as unknown[]) ?? [])[0] ?? {}) as Record<string, unknown>;
        const srcUrl = String(exp?.url ?? "");
        paaQuestions.push({
          question,
          sourceUrl: srcUrl,
          sourceDomain: String(exp?.domain ?? hostnameOf(srcUrl)),
        });
      }
    } else if (type === "organic" && organicTop.length < 10) {
      organicTop.push({
        rank: Number(item.rank_group ?? 0) || 0,
        domain: String(item.domain ?? ""),
        url: String(item.url ?? ""),
      });
    }
  }

  return { aioPresent, aioRefs, paaQuestions, organicTop, costUsd };
}
