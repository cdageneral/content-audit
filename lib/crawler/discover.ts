// ─────────────────────────────────────────────────────────────
//  URL Discovery: sitemap.xml → recursive fallback
// ─────────────────────────────────────────────────────────────

import { parseStringPromise } from "xml2js";

export interface DiscoveryOptions {
  rootUrl: string;
  scopePrefix?: string;
  maxPages?: number;
  auth?: {
    cookie?: string;
    token?: string;
    username?: string;
    password?: string;
  };
}

/**
 * Discover all crawlable URLs for a site.
 * Strategy:
 *   1. Try sitemap.xml / sitemap_index.xml
 *   2. Fall back to recursive link crawl from the root
 * Returns deduped, scope-filtered URLs up to maxPages.
 */
export async function discoverUrls(opts: DiscoveryOptions): Promise<string[]> {
  const { rootUrl, scopePrefix, maxPages = 500 } = opts;
  const origin = new URL(rootUrl).origin;
  const headers = buildAuthHeaders(opts.auth);

  // Phase 1: sitemap
  const sitemapUrls = await tryDiscoverFromSitemap(origin, headers, scopePrefix);
  if (sitemapUrls.length > 0) {
    return sitemapUrls.slice(0, maxPages);
  }

  // Phase 2: recursive BFS
  console.log(`[discover] No sitemap found, falling back to recursive crawl from ${rootUrl}`);
  const bfsUrls = await discoverByBFS(rootUrl, origin, scopePrefix, maxPages, headers);
  return bfsUrls;
}

// ── Sitemap discovery ─────────────────────────────────────────

async function tryDiscoverFromSitemap(
  origin: string,
  headers: HeadersInit,
  scopePrefix?: string
): Promise<string[]> {
  const candidates = [
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap/`,
    `${origin}/sitemaps.xml`,
  ];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) continue;
      const text = await res.text();
      if (!text.trim().startsWith("<")) continue;

      const parsed = await parseStringPromise(text, { explicitArray: false });

      // Sitemap index (contains <sitemapindex>)
      if (parsed.sitemapindex?.sitemap) {
        const children = Array.isArray(parsed.sitemapindex.sitemap)
          ? parsed.sitemapindex.sitemap
          : [parsed.sitemapindex.sitemap];
        const childUrls: string[] = [];
        for (const child of children.slice(0, 20)) {
          const childLoc = child.loc as string;
          const sub = await tryFetchSitemapUrls(childLoc, headers);
          childUrls.push(...sub);
        }
        return filterAndDedupe(childUrls, origin, scopePrefix);
      }

      // Regular sitemap (contains <urlset>)
      if (parsed.urlset?.url) {
        const urls = Array.isArray(parsed.urlset.url)
          ? parsed.urlset.url
          : [parsed.urlset.url];
        const locs = urls.map((u: { loc: string }) =>
          typeof u.loc === "string" ? u.loc : u.loc
        );
        return filterAndDedupe(locs, origin, scopePrefix);
      }
    } catch {
      // Try next candidate
    }
  }

  return [];
}

async function tryFetchSitemapUrls(url: string, headers: HeadersInit): Promise<string[]> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];
    const text = await res.text();
    const parsed = await parseStringPromise(text, { explicitArray: false });
    if (parsed.urlset?.url) {
      const urls = Array.isArray(parsed.urlset.url) ? parsed.urlset.url : [parsed.urlset.url];
      return urls.map((u: { loc: string }) => u.loc as string);
    }
  } catch {
    // swallow
  }
  return [];
}

// ── BFS recursive discovery ───────────────────────────────────

async function discoverByBFS(
  startUrl: string,
  origin: string,
  scopePrefix: string | undefined,
  maxPages: number,
  headers: HeadersInit
): Promise<string[]> {
  const visited = new Set<string>();
  const queue: string[] = [normalizeUrl(startUrl)];
  const discovered: string[] = [];

  // Dynamic import cheerio (commonjs compat)
  const cheerio = await import("cheerio");

  while (queue.length > 0 && discovered.length < maxPages) {
    const batch = queue.splice(0, 5); // process 5 at a time

    await Promise.all(
      batch.map(async (url) => {
        if (visited.has(url)) return;
        visited.add(url);

        try {
          const res = await fetch(url, {
            headers,
            signal: AbortSignal.timeout(15_000),
            redirect: "follow",
          });
          if (!res.ok) return;
          const ct = res.headers.get("content-type") ?? "";
          if (!ct.includes("text/html")) return;

          const html = await res.text();
          const $ = cheerio.load(html);

          $("a[href]").each((_, el) => {
            const href = $(el).attr("href");
            if (!href) return;
            try {
              const resolved = new URL(href, url).href.split("#")[0];
              if (
                resolved.startsWith(origin) &&
                !visited.has(resolved) &&
                !queue.includes(resolved) &&
                isInScope(resolved, origin, scopePrefix) &&
                !isBinaryUrl(resolved)
              ) {
                queue.push(normalizeUrl(resolved));
              }
            } catch {
              // skip bad hrefs
            }
          });

          if (isInScope(url, origin, scopePrefix)) {
            discovered.push(url);
          }
        } catch {
          // skip unreachable
        }
      })
    );
  }

  return filterAndDedupe(discovered, origin, scopePrefix);
}

// ── Helpers ───────────────────────────────────────────────────

function filterAndDedupe(urls: string[], origin: string, scopePrefix?: string): string[] {
  const seen = new Set<string>();
  return urls
    .map((u) => {
      try {
        return normalizeUrl(new URL(u).href);
      } catch {
        return null;
      }
    })
    .filter((u): u is string => {
      if (!u) return false;
      if (!u.startsWith(origin)) return false;
      if (isBinaryUrl(u)) return false;
      if (!isInScope(u, origin, scopePrefix)) return false;
      if (seen.has(u)) return false;
      seen.add(u);
      return true;
    });
}

function isInScope(url: string, origin: string, scopePrefix?: string): boolean {
  if (!scopePrefix) return true;
  const path = url.replace(origin, "");
  return path.startsWith(scopePrefix);
}

function normalizeUrl(url: string): string {
  // Strip trailing slash from non-root paths and query strings unless meaningful
  return url.replace(/\/$/, "") || "/";
}

function isBinaryUrl(url: string): boolean {
  const ext = url.split("?")[0].split(".").pop()?.toLowerCase();
  const binaryExts = [
    "pdf", "png", "jpg", "jpeg", "gif", "svg", "webp", "ico",
    "zip", "tar", "gz", "mp4", "mp3", "wav", "avi", "mov",
    "css", "js", "json", "xml", "rss", "atom", "woff", "woff2", "ttf",
  ];
  return binaryExts.includes(ext ?? "");
}

function buildAuthHeaders(
  auth?: DiscoveryOptions["auth"]
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (compatible; ContentAuditBot/1.0; +https://github.com/you/ai-content-audit)",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  };

  if (auth?.cookie) {
    headers["Cookie"] = auth.cookie;
  }
  if (auth?.token) {
    headers["Authorization"] = `Bearer ${auth.token}`;
  }
  if (auth?.username && auth?.password) {
    const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  }

  return headers;
}
