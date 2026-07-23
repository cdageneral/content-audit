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

export async function fetchUrlKeywordsDfs(
  pageUrl: string,
  database: string,
  limit: number
): Promise<DfsKeywordsResult> {
  const loc = locFor(database);
  let totalCost = 0;

  for (const variant of urlVariantsDfs(pageUrl)) {
    const { rows, costUsd } = await fetchVariantKeywordsDfs(variant, loc, limit);
    totalCost += costUsd;
    if (rows.length > 0) return { rows, costUsd: totalCost, matchedUrl: variant };
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
