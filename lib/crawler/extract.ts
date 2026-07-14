// ─────────────────────────────────────────────────────────────
//  Content Extraction: URL → CrawledPage
//  Uses cheerio for static pages; Playwright for JS-rendered
// ─────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import type { CrawledPage, PageMetadata } from "@/lib/types";

export interface ExtractOptions {
  usePlaywright?: boolean;
  auth?: {
    cookie?: string;
    token?: string;
    username?: string;
    password?: string;
  };
}

/**
 * Crawl a single URL and extract structured content.
 */
export async function extractPage(
  jobId: string,
  url: string,
  opts: ExtractOptions = {}
): Promise<CrawledPage | null> {
  try {
    const { html, status } = opts.usePlaywright
      ? await fetchWithPlaywright(url, opts.auth)
      : await fetchWithFetch(url, opts.auth);

    if (!html) return null;

    return parseHtml(jobId, url, html, status);
  } catch (err) {
    console.error(`[extract] Failed to crawl ${url}:`, err);
    return null;
  }
}

// ── HTML fetch strategies ─────────────────────────────────────

async function fetchWithFetch(
  url: string,
  auth?: ExtractOptions["auth"]
): Promise<{ html: string; status: number }> {
  const headers = buildAuthHeaders(auth);
  const res = await fetch(url, {
    headers,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  const html = await res.text();
  return { html, status: res.status };
}

async function fetchWithPlaywright(
  url: string,
  auth?: ExtractOptions["auth"]
): Promise<{ html: string; status: number }> {
  // Dynamic import: Playwright + chromium only loads in server context
  const { chromium } = await import("playwright-core");
  const chromiumModule = await import("@sparticuz/chromium");

  const browser = await chromium.launch({
    args: chromiumModule.default.args,
    executablePath: await chromiumModule.default.executablePath(),
    headless: true,
  });

  let html = "";
  let status = 200;

  try {
    const context = await browser.newContext({
      extraHTTPHeaders: buildAuthHeaders(auth),
    });

    // Inject cookies if provided
    if (auth?.cookie) {
      const cookiePairs = auth.cookie.split(";").map((c) => {
        const [name, ...rest] = c.trim().split("=");
        return { name: name.trim(), value: rest.join("=").trim(), url };
      });
      await context.addCookies(cookiePairs);
    }

    const page = await context.newPage();

    const response = await page.goto(url, {
      waitUntil: "networkidle",
      timeout: 30_000,
    });

    status = response?.status() ?? 200;
    html = await page.content();
  } finally {
    await browser.close();
  }

  return { html, status };
}

// ── HTML → CrawledPage ────────────────────────────────────────

function parseHtml(
  jobId: string,
  url: string,
  html: string,
  httpStatus: number
): CrawledPage {
  const $ = cheerio.load(html);

  // Remove noise elements
  $(
    "script, style, noscript, nav, footer, header, " +
      "[aria-hidden='true'], .cookie-banner, .ad, .advertisement, " +
      "#nav, #footer, #header, .sidebar, .menu"
  ).remove();

  // Title
  const title =
    $("title").first().text().trim() ||
    $("h1").first().text().trim() ||
    "";

  // Meta description
  const metaDescription =
    $('meta[name="description"]').attr("content") ||
    $('meta[property="og:description"]').attr("content") ||
    "";

  // Headings outline
  const headings: { level: number; text: string }[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const level = parseInt(el.tagName.replace("h", ""), 10);
    const text = $(el).text().trim();
    if (text) headings.push({ level, text });
  });

  // Clean body text
  const bodyText = extractCleanText($);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  // Links
  const origin = new URL(url).origin;
  const internalLinks: string[] = [];
  const externalLinks: string[] = [];

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) return;
    try {
      const resolved = new URL(href, url).href.split("#")[0];
      if (resolved.startsWith(origin)) {
        if (!internalLinks.includes(resolved)) internalLinks.push(resolved);
      } else {
        if (!externalLinks.includes(resolved)) externalLinks.push(resolved);
      }
    } catch {
      // skip
    }
  });

  // Rich metadata
  const metadata = extractMetadata($, url, html);

  return {
    jobId,
    url,
    title,
    metaDescription,
    bodyText,
    wordCount,
    headings,
    internalLinks: internalLinks.slice(0, 100),
    externalLinks: externalLinks.slice(0, 50),
    metadata,
    httpStatus,
    crawledAt: new Date(),
  };
}

function extractCleanText($: cheerio.CheerioAPI): string {
  // Get main content area if possible
  const main =
    $("main, article, [role='main'], .content, #content, .post-content, .entry-content")
      .first()
      .text() ||
    $("body").text();

  return main
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 100_000); // Cap at 100k chars before scoring
}

function extractMetadata(
  $: cheerio.CheerioAPI,
  url: string,
  html: string
): PageMetadata {
  // Author detection
  const author =
    $('meta[name="author"]').attr("content") ||
    $('[rel="author"]').first().text().trim() ||
    $(".author").first().text().trim() ||
    undefined;

  // Dates
  const publishedDate =
    $('meta[property="article:published_time"]').attr("content") ||
    $('time[datetime]').first().attr("datetime") ||
    $('meta[name="date"]').attr("content") ||
    undefined;

  const modifiedDate =
    $('meta[property="article:modified_time"]').attr("content") ||
    $('meta[name="last-modified"]').attr("content") ||
    undefined;

  // Canonical
  const canonicalUrl =
    $('link[rel="canonical"]').attr("href") ||
    $('meta[property="og:url"]').attr("content") ||
    url;

  // OG
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const ogDescription = $('meta[property="og:description"]').attr("content");
  const ogImage = $('meta[property="og:image"]').attr("content");

  // Schema.org
  const hasStructuredData =
    html.includes("application/ld+json") || html.includes("itemtype");
  let schemaOrgType: string | undefined;
  try {
    const ldJson = $('script[type="application/ld+json"]').first().html();
    if (ldJson) {
      const parsed = JSON.parse(ldJson);
      schemaOrgType = parsed["@type"];
    }
  } catch {
    // skip
  }

  // Language
  const language = $("html").attr("lang") || undefined;

  return {
    author,
    publishedDate,
    modifiedDate,
    canonicalUrl,
    ogTitle,
    ogDescription,
    ogImage,
    schemaOrgType,
    hasStructuredData,
    language,
  };
}

function buildAuthHeaders(
  auth?: ExtractOptions["auth"]
): Record<string, string> {
  const headers: Record<string, string> = {
    // Real Chrome UA (see discover.ts) — the crawl step must match discovery or
    // a UA-blocking site would pass discovery but return challenges at crawl.
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };

  if (auth?.cookie) headers["Cookie"] = auth.cookie;
  if (auth?.token) headers["Authorization"] = `Bearer ${auth.token}`;
  if (auth?.username && auth?.password) {
    const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  }

  return headers;
}
