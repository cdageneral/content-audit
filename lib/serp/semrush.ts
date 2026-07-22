// ─────────────────────────────────────────────────────────────
//  Semrush Analytics API client — AIO / PAA visibility detection.
//
//  Verified per-keyword facts only (no modeled data):
//    · Fk ("SERP Features by Keyword")  ∋ 52 → keyword triggers an AI Overview
//    · Fp ("SERP Features by Position") ∋ 52 → THIS URL is cited inside it
//    · Fk ∋ 21 → keyword's SERP has a People Also Ask box
//    · Fp ∋ 21 → THIS URL is a PAA answer source
//  Feature codes verified against developer.semrush.com/api/v3/seo/overview/
//  and live MCP calls (chip.ca, 2026-07-21).
//
//  Cost model: Analytics API bills ~10 units per response line (live data).
//  Every fetch returns unitsSpent so callers can enforce budgets. Requires a
//  Business-plan API key with purchased units in SEMRUSH_API_KEY; every entry
//  point degrades to "not configured" without it.
//
//  Parsing is defensive: columns are mapped by CSV HEADER TEXT, never by
//  position or two-letter code assumptions, so a Semrush column reshuffle
//  can't silently mis-map data.
// ─────────────────────────────────────────────────────────────

export const FEATURE_PAA = 21;
export const FEATURE_AIO = 52;

const API_BASE = "https://api.semrush.com/";
const UNITS_PER_LINE = 10;
const FETCH_TIMEOUT_MS = 20_000;

export interface SerpKeywordRow {
  keyword: string;
  position: number;
  volume: number;
  url: string;
  /** feature codes present on the keyword's SERP (Fk) */
  triggeredFeatures: number[];
  /** feature codes THIS url occupies (Fp) */
  positionFeatures: number[];
  positionType: string;
  aioTriggered: boolean;
  aioCited: boolean;
  paaPresent: boolean;
  paaOwned: boolean;
}

export interface SerpQuestionRow {
  question: string;
  volume: number;
}

export function serpConfigured(): boolean {
  return !!process.env.SEMRUSH_API_KEY;
}

export function serpDefaultDatabase(): string {
  return process.env.SEMRUSH_DEFAULT_DATABASE ?? "us";
}

// ── Low-level fetch + CSV parsing ─────────────────────────────

async function semrushGet(params: Record<string, string>): Promise<string> {
  const key = process.env.SEMRUSH_API_KEY;
  if (!key) throw new Error("SEMRUSH_API_KEY not set");
  const qs = new URLSearchParams({ ...params, key });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}?${qs.toString()}`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Semrush HTTP ${res.status}: ${text.slice(0, 200)}`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** "ERROR 50 :: NOTHING FOUND" is an empty result, not a failure. */
function isNothingFound(text: string): boolean {
  return /^ERROR\s+50\b/.test(text.trim());
}

function assertNoApiError(text: string): void {
  const t = text.trim();
  if (t.startsWith("ERROR") && !isNothingFound(t)) {
    // e.g. ERROR 120 :: WRONG KEY, ERROR 132 :: API UNITS BALANCE IS ZERO
    throw new Error(`Semrush API: ${t.slice(0, 200)}`);
  }
}

/** Parse Semrush ';'-separated CSV into header-keyed records. */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split(";");
    // A keyword containing ';' would shift columns — drop the row rather
    // than store mis-mapped data.
    if (cells.length !== headers.length) continue;
    const rec: Record<string, string>= {};
    headers.forEach((h, idx) => (rec[h] = cells[idx].trim()));
    rows.push(rec);
  }
  return rows;
}

function pickColumn(rec: Record<string, string>, candidates: string[]): string {
  for (const c of candidates) {
    if (rec[c] !== undefined) return rec[c];
  }
  return "";
}

function parseFeatureList(raw: string): number[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n));
}

// ── URL keyword inventory (domain_organic filtered by Ur) ─────

export interface UrlKeywordsResult {
  rows: SerpKeywordRow[];
  unitsSpent: number;
}

/**
 * Keywords a specific URL ranks for (Google top 100, incl. SERP-feature-only
 * positions), with AIO/PAA flags derived per row. Tries the exact URL, then
 * the trailing-slash-toggled variant if nothing matched ("NOTHING FOUND"
 * responses cost no units).
 */
export async function fetchUrlKeywords(
  pageUrl: string,
  database: string,
  limit: number
): Promise<UrlKeywordsResult> {
  const domain = new URL(pageUrl).hostname.replace(/^www\./, "");
  const variants = [pageUrl, toggleTrailingSlash(pageUrl)];
  let unitsSpent = 0;

  for (const variant of variants) {
    const text = await semrushGet({
      type: "domain_organic",
      domain,
      database,
      display_limit: String(limit),
      display_sort: "nq_desc",
      display_positions_type: "all",
      display_filter: `+|Ur|Eq|${variant}`,
      export_columns: "Ph,Po,Nq,Ur,Fp,Fk,Pt",
    });
    if (isNothingFound(text)) continue;
    assertNoApiError(text);

    const rows = parseCsv(text).map((rec): SerpKeywordRow => {
      const triggered = parseFeatureList(
        pickColumn(rec, ["serp features by keyword", "fk"])
      );
      const positioned = parseFeatureList(
        pickColumn(rec, ["serp features by position", "fp"])
      );
      return {
        keyword: pickColumn(rec, ["keyword", "ph"]),
        position: parseInt(pickColumn(rec, ["position", "po"]), 10) || 0,
        volume: parseInt(pickColumn(rec, ["search volume", "nq"]), 10) || 0,
        url: pickColumn(rec, ["url", "ur"]) || variant,
        triggeredFeatures: triggered,
        positionFeatures: positioned,
        positionType: pickColumn(rec, ["position type", "pt"]),
        aioTriggered: triggered.includes(FEATURE_AIO),
        aioCited: positioned.includes(FEATURE_AIO),
        paaPresent: triggered.includes(FEATURE_PAA),
        paaOwned: positioned.includes(FEATURE_PAA),
      };
    }).filter((r) => r.keyword.length > 0);

    unitsSpent += rows.length * UNITS_PER_LINE;
    if (rows.length > 0) return { rows, unitsSpent };
  }

  return { rows: [], unitsSpent };
}

function toggleTrailingSlash(url: string): string {
  if (url.endsWith("/")) return url.slice(0, -1);
  return `${url}/`;
}

// ── Question mining (phrase_questions) ────────────────────────

export interface QuestionsResult {
  rows: SerpQuestionRow[];
  unitsSpent: number;
}

/**
 * Question-form queries around a seed keyword, by volume. These are search
 * queries (the pool PAA draws from), NOT the literal PAA box text — the UI
 * must label them accordingly.
 */
export async function fetchQuestions(
  seedKeyword: string,
  database: string,
  limit: number
): Promise<QuestionsResult> {
  const text = await semrushGet({
    type: "phrase_questions",
    phrase: seedKeyword,
    database,
    display_limit: String(limit),
    display_sort: "nq_desc",
    export_columns: "Ph,Nq",
  });
  if (isNothingFound(text)) return { rows: [], unitsSpent: 0 };
  assertNoApiError(text);

  const rows = parseCsv(text)
    .map((rec) => ({
      question: pickColumn(rec, ["keyword", "ph"]),
      volume: parseInt(pickColumn(rec, ["search volume", "nq"]), 10) || 0,
    }))
    .filter((r) => r.question.length > 0);

  return { rows, unitsSpent: rows.length * UNITS_PER_LINE };
}

// ── Primary keyword + branded detection ───────────────────────

/** Highest-volume keyword ranking ≤20; tie-break on better position. */
export function pickPrimaryKeyword(rows: SerpKeywordRow[]): string | null {
  const eligible = rows.filter((r) => r.position > 0 && r.position <= 20);
  const pool = eligible.length > 0 ? eligible : rows;
  if (pool.length === 0) return null;
  const sorted = [...pool].sort(
    (a, b) => b.volume - a.volume || a.position - b.position
  );
  return sorted[0].keyword;
}

/** Cheap branded test: any token of the client name (≥4 chars) in keyword. */
export function isBrandedKeyword(keyword: string, clientName: string): boolean {
  const kw = keyword.toLowerCase();
  return clientName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 4)
    .some((t) => kw.includes(t));
}
