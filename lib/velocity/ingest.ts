// ─────────────────────────────────────────────────────────────
//  lib/velocity/ingest.ts — record a finished job's observed URL
//  set into content_inventory (server-only).
//
//  Called (dynamically, fully caught) from updateJobStatus when a
//  job reaches 'done' — same funnel-point pattern as the scheduled
//  -scan finalize hook, and under the same contract: velocity
//  bookkeeping must NEVER fail (or retry) a webhook batch, so
//  every error here is swallowed by the caller.
//
//  Two sources per job, both observed:
//   1. The crawl — every audit_pages row, with the publish date the
//      crawler extracted from the page itself (metadata JSONB).
//   2. The site's sitemap.xml — the URL set beyond the crawl cap,
//      with <lastmod> kept as a labeled hint (never presented as a
//      publish date). Bounded: 10s per fetch, 10 child sitemaps,
//      ~20s soft budget, 8000 URLs.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { parseStringPromise } from "xml2js";
import { recordInventory, type InventoryEntry } from "./store";

function db() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
}

// ── Date validation ───────────────────────────────────────────

const MIN_DATE_MS = Date.UTC(1995, 0, 1);

/**
 * Parse a claimed date string into a trustworthy ISO timestamp, or null.
 * Rejects unparseable values, dates before 1995, and dates more than a
 * day in the future (clock skew allowance) — stored page metadata is
 * whatever the site claimed, so it is validated on every read.
 */
export function parseSaneDate(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const t = Date.parse(raw.trim());
  if (Number.isNaN(t)) return null;
  if (t < MIN_DATE_MS) return null;
  if (t > Date.now() + 24 * 60 * 60 * 1000) return null;
  return new Date(t).toISOString();
}

// ── Sitemap entries (URL + lastmod) ───────────────────────────

export interface SitemapEntry {
  url: string;
  lastmod: string | null;
}

const SITEMAP_FETCH_HEADERS = {
  // Same real-Chrome presentation as discovery/crawl (see lib/crawler/discover.ts).
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const BINARY_EXTS = new Set([
  "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
  "zip", "tar", "gz", "mp4", "mp3", "wav", "avi", "mov",
  "css", "js", "json", "xml", "rss", "atom", "woff", "woff2", "ttf",
]);

function isBinaryUrl(url: string): boolean {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  return BINARY_EXTS.has(ext ?? "");
}

type RawSitemapUrl = { loc?: unknown; lastmod?: unknown };

function urlsetEntries(parsed: Record<string, any>): SitemapEntry[] {
  if (!parsed?.urlset?.url) return [];
  const raw: RawSitemapUrl[] = Array.isArray(parsed.urlset.url)
    ? parsed.urlset.url
    : [parsed.urlset.url];
  const out: SitemapEntry[] = [];
  for (const u of raw) {
    const loc = typeof u?.loc === "string" ? u.loc.trim() : null;
    if (!loc) continue;
    out.push({ url: loc, lastmod: parseSaneDate(u?.lastmod) });
  }
  return out;
}

async function fetchXml(url: string): Promise<Record<string, any> | null> {
  try {
    const res = await fetch(url, {
      headers: SITEMAP_FETCH_HEADERS,
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text.trim().startsWith("<")) return null;
    return await parseStringPromise(text, { explicitArray: false });
  } catch {
    return null;
  }
}

/**
 * Fetch a site's sitemap URL set with lastmod values. Bounded and
 * best-effort — returns [] on any failure. Mirrors the candidate list in
 * lib/crawler/discover.ts but keeps <lastmod> (discovery throws it away).
 *
 * scopePrefix: when the audit is scoped to a line of business (a path
 * prefix), the sitemap set is filtered to it — velocity MIRRORS THE AUDIT
 * SCOPE, so a /banking/ project never counts the rest of the domain.
 */
export async function fetchSitemapEntries(
  siteUrl: string,
  scopePrefix?: string | null
): Promise<SitemapEntry[]> {
  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return [];
  }

  const MAX_URLS = 8000;
  const MAX_CHILDREN = 10;
  const SOFT_BUDGET_MS = 20_000;
  const started = Date.now();

  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemaps.xml`,
  ];

  for (const candidate of candidates) {
    if (Date.now() - started > SOFT_BUDGET_MS) break;
    const parsed = await fetchXml(candidate);
    if (!parsed) continue;

    // Sitemap index → fetch children (bounded).
    if (parsed.sitemapindex?.sitemap) {
      const children = Array.isArray(parsed.sitemapindex.sitemap)
        ? parsed.sitemapindex.sitemap
        : [parsed.sitemapindex.sitemap];
      const out: SitemapEntry[] = [];
      for (const child of children.slice(0, MAX_CHILDREN)) {
        if (Date.now() - started > SOFT_BUDGET_MS) break;
        if (out.length >= MAX_URLS) break;
        const childLoc = typeof child?.loc === "string" ? child.loc.trim() : null;
        if (!childLoc) continue;
        const childParsed = await fetchXml(childLoc);
        if (childParsed) out.push(...urlsetEntries(childParsed));
      }
      return filterEntries(out, origin, scopePrefix).slice(0, MAX_URLS);
    }

    const entries = urlsetEntries(parsed);
    if (entries.length > 0) return filterEntries(entries, origin, scopePrefix).slice(0, MAX_URLS);
  }

  return [];
}

function filterEntries(
  entries: SitemapEntry[],
  origin: string,
  scopePrefix?: string | null
): SitemapEntry[] {
  const seen = new Set<string>();
  const out: SitemapEntry[] = [];
  for (const e of entries) {
    let normalized: string;
    try {
      normalized = new URL(e.url).href.split("#")[0].replace(/\/$/, "") || "/";
    } catch {
      continue;
    }
    if (!normalized.startsWith(origin)) continue;
    // Same in-scope semantics as lib/crawler/discover.ts isInScope().
    if (scopePrefix && !normalized.replace(origin, "").startsWith(scopePrefix)) continue;
    if (isBinaryUrl(normalized)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push({ url: normalized, lastmod: e.lastmod });
  }
  return out;
}

// ── Job ingest (the updateJobStatus hook target) ──────────────

/**
 * Record a finished job's crawl + sitemap URL sets into content_inventory.
 * Safe to call for any job: exits immediately for jobs with no project
 * (legacy single audits). Idempotent — re-running for the same job only
 * refreshes last_seen_at.
 */
export async function ingestVelocityForJob(jobId: string): Promise<void> {
  const sql = db();

  const jobRows = await sql`
    SELECT project_id, competitor_id, url, scope_prefix FROM audit_jobs WHERE id = ${jobId}
  `;
  const job = jobRows[0];
  if (!job?.project_id) return;

  const projectId = String(job.project_id);
  const competitorId = job.competitor_id ? String(job.competitor_id) : null;
  const scopePrefix = job.scope_prefix ? String(job.scope_prefix) : null;

  // Velocity MIRRORS THE AUDIT SCOPE (Wayne's rule, 2026-07-30):
  //  - competitor jobs are always domain/scope crawls → sitemap OK, filtered
  //    by the competitor's scope prefix;
  //  - client jobs consult the project's audit source: 'domain' → sitemap
  //    (filtered by scope prefix); 'single'/'list' → crawl rows ONLY, so the
  //    listed URLs define the whole counting universe and the rest of the
  //    domain never inflates the numbers.
  let includeSitemap = true;
  if (!competitorId) {
    const projRows = await sql`
      SELECT audit_source FROM projects WHERE id = ${projectId}
    `.catch(() => [] as Record<string, unknown>[]);
    const source = String(projRows[0]?.audit_source ?? "domain");
    includeSitemap = source === "domain";
  }

  // Source 1: the crawl — URL + the publish date extracted from the page.
  const pageRows = await sql`
    SELECT url, metadata FROM audit_pages WHERE job_id = ${jobId}
  `;
  const entries: InventoryEntry[] = [];
  for (const r of pageRows) {
    const meta = (r.metadata ?? {}) as Record<string, unknown>;
    const publishedAt = parseSaneDate(meta.publishedDate);
    entries.push({
      url: String(r.url),
      publishedAt,
      publishedSource: publishedAt ? "page" : null,
      lastmod: null,
    });
  }

  // Source 2: the sitemap — URL set beyond the crawl cap, lastmod as a hint.
  const sitemapEntries = includeSitemap
    ? await fetchSitemapEntries(String(job.url), scopePrefix).catch(() => [])
    : [];
  for (const e of sitemapEntries) {
    entries.push({
      url: e.url,
      publishedAt: null,
      publishedSource: null,
      lastmod: e.lastmod,
    });
  }

  const { inserted, updated } = await recordInventory({
    projectId,
    competitorId,
    jobId,
    entries,
  });
  console.log(
    `[velocity] job ${jobId}: inventory recorded (${inserted} new, ${updated} seen again, ${sitemapEntries.length} sitemap URLs)`
  );
}
