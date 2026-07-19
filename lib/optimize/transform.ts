// ─────────────────────────────────────────────────────────────
//  Draft ⇄ CrawledPage transforms — the parity contract.
//
//  The simulator must score EXACTLY what a real crawl of the
//  published page would score. Both directions here mirror
//  lib/crawler/extract.ts step for step:
//
//  seedMarkdownFromPage:  stored crawl → editable markdown
//  draftToCrawledPage:    edited markdown → CrawledPage
//
//  Round-trip invariant (tested by the unchanged-content case):
//  seeding a page and converting it straight back produces a
//  byte-identical scoring input, so computeContentHash matches the
//  baseline hash and findReusableScore returns the stored baseline
//  score without a model call. If content DID change, the derived
//  bodyText/headings/wordCount are built with the same formulas the
//  crawler uses, so publishing the draft verbatim reproduces the
//  simulated input on the next real audit.
// ─────────────────────────────────────────────────────────────

import type { CrawledPage, PageMetadata } from "@/lib/types";
import type { StoredPage } from "@/lib/db/client";

export interface DraftContent {
  title: string;
  metaDescription: string;
  bodyMd: string;
  metadata: PageMetadata;
  internalLinks: string[];
  externalLinks: string[];
}

/**
 * Rebuild an editable markdown document from the flat crawled bodyText by
 * re-inserting heading markers at each stored heading's first occurrence
 * (headings are stored in DOM order, and their text is part of bodyText).
 * Headings whose text can't be located are skipped rather than guessed.
 */
export function seedMarkdownFromPage(page: StoredPage): string {
  const body = page.bodyText;
  let cursor = 0;
  let out = "";

  for (const h of page.headings) {
    const text = (h.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const idx = body.indexOf(text, cursor);
    if (idx === -1) continue;
    const level = Math.min(6, Math.max(1, h.level || 2));
    out += body.slice(cursor, idx);
    out += `\n\n${"#".repeat(level)} ${text}\n\n`;
    cursor = idx + text.length;
  }
  out += body.slice(cursor);

  return out
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Headings parsed from markdown `#`-prefix lines, in document order. */
export function parseMarkdownHeadings(
  md: string
): { level: number; text: string }[] {
  const headings: { level: number; text: string }[] = [];
  for (const line of md.split("\n")) {
    const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) {
      const text = m[2].replace(/\s+/g, " ").trim();
      if (text) headings.push({ level: m[1].length, text });
    }
  }
  return headings;
}

/**
 * Convert the edited draft into the exact CrawledPage shape the scorer
 * consumes. Formula-parity with lib/crawler/extract.ts:
 *  - bodyText: markers stripped, [text](url) links reduced to their anchor
 *    text, then `.replace(/\s+/g," ").trim().slice(0,100000)` — identical to
 *    extractCleanText's collapse.
 *  - wordCount: `bodyText.split(/\s+/).filter(Boolean).length` — identical.
 *  - links: the draft's link lists (seeded from the crawl) plus any markdown
 *    links added inline, deduped, internal/external split by origin, capped
 *    100/50 — identical to the crawler's caps.
 */
export function draftToCrawledPage(
  jobId: string,
  url: string,
  draft: DraftContent,
  httpStatus: number
): CrawledPage {
  const headings = parseMarkdownHeadings(draft.bodyMd);

  // Links: seeded lists + inline markdown additions
  let origin = "";
  try {
    origin = new URL(url).origin;
  } catch {
    // leave empty — every parsed link will classify as external
  }
  const internalLinks = [...draft.internalLinks];
  const externalLinks = [...draft.externalLinks];
  const linkRe = /\[([^\]]*)\]\(([^)\s]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(draft.bodyMd)) !== null) {
    const href = m[2];
    if (!href || href.startsWith("#") || href.startsWith("mailto:")) continue;
    try {
      const resolved = new URL(href, url).href.split("#")[0];
      if (origin && resolved.startsWith(origin)) {
        if (internalLinks.indexOf(resolved) === -1) internalLinks.push(resolved);
      } else {
        if (externalLinks.indexOf(resolved) === -1) externalLinks.push(resolved);
      }
    } catch {
      // skip unparseable hrefs
    }
  }

  // Body text: strip heading markers + reduce links to anchor text, then
  // collapse exactly like the crawler does.
  const stripped = draft.bodyMd
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, ""))
    .join("\n")
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1");
  const bodyText = stripped.replace(/\s+/g, " ").trim().slice(0, 100_000);
  const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

  return {
    jobId,
    url,
    title: draft.title,
    metaDescription: draft.metaDescription,
    bodyText,
    wordCount,
    headings,
    internalLinks: internalLinks.slice(0, 100),
    externalLinks: externalLinks.slice(0, 50),
    metadata: draft.metadata,
    httpStatus,
    crawledAt: new Date(),
  };
}

/** Normalize a StoredPage's loose metadata into the typed PageMetadata shape. */
export function pageMetadataFromStored(page: StoredPage): PageMetadata {
  const md = page.metadata ?? {};
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.trim() ? v : undefined;
  return {
    author: str(md.author),
    publishedDate: str(md.publishedDate),
    modifiedDate: str(md.modifiedDate),
    canonicalUrl: str(md.canonicalUrl),
    ogTitle: str(md.ogTitle),
    ogDescription: str(md.ogDescription),
    ogImage: str(md.ogImage),
    schemaOrgType: str(md.schemaOrgType),
    hasStructuredData: md.hasStructuredData === true,
    language: str(md.language),
  };
}
