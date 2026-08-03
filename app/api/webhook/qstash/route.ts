// POST /api/webhook/qstash
// Receives async batch jobs from QStash: crawl_batch and score_batch
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/queue/qstash";
import { extractPage } from "@/lib/crawler/extract";
import { scoreBatch, classifyBatch, computeContentHash } from "@/lib/scoring";
import {
  upsertPage,
  upsertScore,
  getPagesByJob,
  updateJobStatus,
  incrementJobProgress,
  countScoresByJob,
  getJob,
  updatePageClassification,
  findReusableScore,
  type StoredPage,
} from "@/lib/db/client";
import { enqueueScoreBatch } from "@/lib/queue/qstash";
import type { SerpBatchMessage } from "@/lib/queue/qstash";
import {
  serpConfigured,
  fetchUrlKeywords,
  fetchVolumesSemrush,
  fetchQuestions,
  pickPrimaryKeyword,
  isBrandedKeyword,
} from "@/lib/serp/semrush";
import { insertSnapshot, findMonthlySnapshot } from "@/lib/db/serp";
import type { OccupantInput } from "@/lib/db/serp";
import {
  dfsConfigured,
  fetchUrlKeywordsDfs,
  fetchSerpLiveDfs,
} from "@/lib/serp/dataforseo";
import { getSerpScoringContext } from "@/lib/serp/context";
import { dispatchSerpBatches } from "@/lib/serp/dispatch";
import { runLlmPrompt } from "@/lib/serp/llm";
import {
  getPromptsByIds,
  insertPromptCheck,
  urlKey as promptUrlKey,
} from "@/lib/db/prompts";
import type { PromptEngine, PromptCitation } from "@/lib/db/prompts";
import { PROMPT_ENGINES } from "@/lib/db/prompts";
import { getProject } from "@/lib/db/projects";
import type { PromptBatchMessage } from "@/lib/queue/qstash";
import { recordApiCall } from "@/lib/usage/record";
import { neon } from "@neondatabase/serverless";
import type {
  CrawlBatchMessage,
  ScoreBatchMessage,
  ClassifyBatchMessage,
  DimensionScores,
  CrawledPage,
} from "@/lib/types";
import { DEFAULT_WEIGHTS } from "@/lib/types";

// ── Block detection ───────────────────────────────────────────
// A site "blocks" our crawler when it returns an auth/rate-limit/forbidden
// status, or serves a bot-challenge interstitial (Cloudflare, Incapsula, etc.)
// in place of real content. Such responses must not be stored or scored.
const BLOCK_STATUS = new Set([401, 403, 407, 429, 451, 503]);
const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "attention required",
  "cloudflare",
  "captcha",
  "access denied",
  "request unsuccessful",
  "pardon our interruption",
  "verify you are human",
  "enable javascript and cookies",
];

function isBlockedPage(page: {
  httpStatus: number;
  title: string;
  bodyText: string;
  wordCount: number;
}): boolean {
  if (BLOCK_STATUS.has(page.httpStatus)) return true;
  // 200 OK but a near-empty interstitial carrying a known challenge phrase.
  if (page.wordCount < 60) {
    const hay = `${page.title} ${page.bodyText.slice(0, 2000)}`.toLowerCase();
    if (CHALLENGE_MARKERS.some((m) => hay.includes(m))) return true;
  }
  return false;
}

// ── Thin-content detection ────────────────────────────────────
// A page can come back HTTP 200, carry no challenge phrase, and still hold
// almost no readable text — the signature of copy that only exists after
// client-side rendering. Before 2026-07-26 such a page was stored and scored
// as-is, so its dimension scores were computed against essentially nothing.
// Neither guard above catches it: isBlockedPage() needs a blocked status or a
// known challenge phrase, and the batch-level headless rescue only fires when
// EVERY page in the batch failed.
//
// The tell is the pairing, not the word count alone: a genuinely short page
// has short HTML too. Large HTML + almost no extractable text = worth a
// browser. 120 words is roughly the floor below which the 10 scoring
// dimensions have nothing real to judge, so a false positive costs one browser
// launch and a true positive rescues a page that would otherwise score noise.
const THIN_WORDS = 120;
const THIN_HTML_BYTES = 20_000;

// Headless is slow (browser launch + networkidle per page) and this handler
// has a single 300s budget shared with up to BATCH_SIZE plain fetches, so the
// retry is capped both by count and by wall clock.
const THIN_HEADLESS_MAX = 3;
const THIN_RESCUE_DEADLINE_MS = 210_000;

function isThinPage(page: {
  wordCount: number;
  httpStatus: number;
  htmlBytes?: number;
}): boolean {
  if (page.httpStatus >= 400) return false; // an error page is a different problem
  if (page.wordCount >= THIN_WORDS) return false;
  return (page.htmlBytes ?? 0) >= THIN_HTML_BYTES;
}

/**
 * Per-page rescue for suspiciously thin 200s. The plain-fetch version has
 * already been stored, so this can only improve things: the headless result
 * replaces it ONLY when it yields strictly more words. Any failure leaves the
 * stored page untouched and never fails the job.
 */
async function rescueThinPages(
  jobId: string,
  thin: { url: string; words: number }[],
  auth: CrawlBatchMessage["auth"],
  batchStartedAt: number
): Promise<number> {
  // Worst offenders first, so the cap spends the budget where it matters.
  const ordered = [...thin].sort((a, b) => a.words - b.words);
  const batch = ordered.slice(0, THIN_HEADLESS_MAX);
  const dropped = ordered.length - batch.length;
  if (dropped > 0) {
    // Never let a cap read as "we checked everything".
    console.warn(
      `[crawl] Job ${jobId}: ${ordered.length} thin pages, retrying the ${batch.length} thinnest — ${dropped} left as crawled (cap ${THIN_HEADLESS_MAX}/batch).`
    );
  }

  let improved = 0;
  for (const { url, words } of batch) {
    if (Date.now() - batchStartedAt > THIN_RESCUE_DEADLINE_MS) {
      // Out of time: the stored plain-fetch copies stand. Say so rather than
      // letting a silent skip look like "headless found nothing".
      console.warn(
        `[crawl] Job ${jobId}: out of time budget — skipping headless retry for ${url} and any remaining thin pages.`
      );
      break;
    }
    try {
      const page = await extractPage(jobId, url, {
        usePlaywright: true,
        auth: auth ?? undefined,
      });
      if (page && !isBlockedPage(page) && page.wordCount > words) {
        await upsertPage(page);
        improved++;
        console.log(
          `[crawl] 🅟↑ ${url}: ${words} → ${page.wordCount} words (headless)`
        );
      } else {
        console.warn(
          `[crawl] 🅟= ${url}: headless gave no more text (${words} words kept) — page is genuinely thin.`
        );
      }
    } catch (err) {
      console.error(`[crawl] thin-rescue error ${url} — keeping plain-fetch copy:`, err);
    }
  }
  return improved;
}

function blockedMessage(status: number): string {
  const code = status && status >= 400 ? `HTTP ${status}` : "bot challenge";
  return `This site blocks automated crawling (${code}), so it can't be audited. The crawl was stopped after repeated blocks. If the site relies on JavaScript, enabling headless-browser crawling may help.`;
}

// Max URLs to retry with the (slow, heavy) headless browser before giving up.
const HEADLESS_MAX = 5;

function blockedMessageHeadless(status: number): string {
  const code = status && status >= 400 ? `HTTP ${status}` : "bot challenge";
  return `This site blocks automated crawling (${code}) and stayed blocked even after a second pass with a full headless browser. The audit was stopped — this site can't be crawled automatically.`;
}

// Second-pass rescue: re-crawl a blocked site's URLs with a real headless
// browser (Playwright). Returns the number of pages successfully stored. Bails
// early once it's clear the site is hard-walled, to protect the function time
// budget. Any launch/runtime error degrades to "still blocked" (0 salvaged).
async function tryHeadlessRescue(
  jobId: string,
  urls: string[],
  auth: CrawlBatchMessage["auth"]
): Promise<number> {
  console.warn(`[crawl] Job ${jobId}: plain-fetch blocked — trying headless browser (Playwright)…`);
  let ok = 0;
  const cap = Math.min(urls.length, HEADLESS_MAX);
  for (let i = 0; i < cap; i++) {
    const url = urls[i];
    try {
      const page = await extractPage(jobId, url, {
        usePlaywright: true,
        auth: auth ?? undefined,
      });
      if (page && !isBlockedPage(page)) {
        await upsertPage(page);
        ok++;
        console.log(`[crawl] 🅟 ${url} (headless)`);
      } else {
        console.warn(`[crawl] 🅟⛔ ${url}: still blocked (headless)`);
      }
    } catch (err) {
      console.error(`[crawl] headless error ${url}:`, err);
    } finally {
      await incrementJobProgress(jobId, "crawled_pages");
    }
    // Hard-walled: if the first two headless attempts also fail, stop early.
    if (ok === 0 && i >= 1) break;
  }
  return ok;
}

export async function POST(req: NextRequest) {
  const { valid, body } = await verifyQStashSignature(req);

  if (!valid) {
    console.warn("[qstash] Invalid signature — rejecting");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const msg = body as { type: string } & Record<string, unknown>;

  try {
    if (msg.type === "crawl_batch") {
      await handleCrawlBatch(msg as unknown as CrawlBatchMessage & { type: string });
    } else if (msg.type === "score_batch") {
      await handleScoreBatch(msg as unknown as ScoreBatchMessage & { type: string });
    } else if (msg.type === "classify_batch") {
      await handleClassifyBatch(msg as unknown as ClassifyBatchMessage & { type: string });
    } else if (msg.type === "serp_batch") {
      await handleSerpBatch(msg as unknown as SerpBatchMessage & { type: string });
    } else if (msg.type === "prompt_batch") {
      await handlePromptBatch(msg as unknown as PromptBatchMessage & { type: string });
    } else if (msg.type === "test") {
      console.log("[qstash] Test message received — OK");
    } else {
      console.warn(`[qstash] Unknown message type: ${msg.type}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[qstash] Handler error:", err);
    // Return 5xx so QStash retries (retries=2). Previously this returned 200,
    // which QStash reads as success — a transient failure would silently drop
    // the batch and stall the job forever with no self-heal. Score/crawl writes
    // are idempotent (upsertPage ON CONFLICT, upsertScore delete+insert, and the
    // atomic 'scoring' claim), so retries are safe.
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

// ── Crawl batch handler ───────────────────────────────────────

async function handleCrawlBatch(
  msg: CrawlBatchMessage & { type: string }
): Promise<void> {
  const { jobId, urls, auth, batchIndex, totalBatches } = msg;

  console.log(`[crawl] Job ${jobId}: batch ${batchIndex + 1}/${totalBatches} (${urls.length} URLs)`);

  const batchStartedAt = Date.now();

  const job = await getJob(jobId);
  if (!job || job.status === "failed" || job.status === "scoring" || job.status === "done") return;

  let okCount = 0;
  let blockedCount = 0;
  let lastBlockStatus = 0;
  // 200s that stored almost no text — retried in a real browser after this pass.
  const thinPages: { url: string; words: number }[] = [];

  for (let u = 0; u < urls.length; u++) {
    const url = urls[u];
    try {
      const page = await extractPage(jobId, url, {
        usePlaywright: false,
        auth: auth ?? undefined,
      });
      if (page && isBlockedPage(page)) {
        // A block/challenge page is not real content — don't store or score it.
        blockedCount++;
        lastBlockStatus = page.httpStatus;
        console.warn(`[crawl] ⛔ ${url}: blocked (HTTP ${page.httpStatus})`);
      } else if (page) {
        await upsertPage(page);
        okCount++;
        if (isThinPage(page)) {
          // Stored so nothing is lost, but flagged: large HTML, almost no text.
          thinPages.push({ url, words: page.wordCount });
          console.warn(
            `[crawl] ✓⚠ ${url}: only ${page.wordCount} words from ${page.htmlBytes} bytes of HTML — queued for headless retry.`
          );
        } else {
          console.log(`[crawl] ✓ ${url}`);
        }
      } else {
        console.warn(`[crawl] ✗ ${url}: returned null (empty or unreachable)`);
      }
    } catch (err) {
      console.error(`[crawl] ✗ ${url}:`, err);
    } finally {
      // Always count as attempted — blocked/timed-out pages must not stall the pipeline
      await incrementJobProgress(jobId, "crawled_pages");
    }

    // Early stop scanning: after repeated blocks with nothing getting through,
    // end the plain-fetch pass now (avoids a function timeout) and hand off to
    // the headless-browser second pass below. Account for the URLs we're
    // skipping so crawled_pages still reaches total_pages — the scoring-claim
    // gate below keys off that counter and must not stall on an early break.
    if (okCount === 0 && blockedCount >= 3) {
      const skipped = urls.length - (u + 1);
      if (skipped > 0) await incrementJobProgress(jobId, "crawled_pages", skipped);
      console.warn(
        `[crawl] Job ${jobId}: ${blockedCount} blocks, 0 crawled — ending plain-fetch pass, escalating to headless.`
      );
      break;
    }
  }

  // ── Second pass: full headless browser (Playwright) ─────────
  // If the plain-fetch crawler got nothing but hit blocks, the site may be
  // JS-rendered or bot-walling simple requests. Retry with a real browser
  // before giving up. If it's STILL blocked, stop with a clear alert.
  if (okCount === 0 && blockedCount > 0) {
    const salvaged = await tryHeadlessRescue(jobId, urls, auth);
    if (salvaged === 0) {
      await updateJobStatus(jobId, "failed", {
        errorMessage: blockedMessageHeadless(lastBlockStatus),
      });
      console.warn(`[crawl] Job ${jobId}: blocked even with a headless browser — stopped.`);
      return;
    }
    okCount += salvaged;
    console.log(`[crawl] Job ${jobId}: headless rescue salvaged ${salvaged} page(s).`);
  }

  // ── Thin-page rescue ────────────────────────────────────────
  // Separate from the block rescue above: this runs even when the batch
  // mostly succeeded, because a single JS-rendered page inside a healthy
  // site would otherwise be scored against an empty body. Pages are already
  // stored, so this only ever upgrades them — progress counters are NOT
  // re-incremented here.
  if (thinPages.length > 0) {
    const improved = await rescueThinPages(jobId, thinPages, auth, batchStartedAt);
    console.log(
      `[crawl] Job ${jobId}: thin-page retry improved ${improved}/${thinPages.length} page(s).`
    );
  }

  // Re-fetch job to get latest crawled count after this batch
  const updatedJob = await getJob(jobId);
  if (!updatedJob || updatedJob.status !== "crawling") return;

  // Claim the scoring transition ONLY once every crawl attempt across all
  // batches has completed — i.e. crawled_pages has reached total_pages. Each
  // URL bumps crawled_pages in `finally` AFTER its page upsert is awaited, so
  // when the counter hits the total, every page that will be committed IS
  // committed. This closes the claim-race where one batch grabbed the 'scoring'
  // lock and dispatched a partial page set while a concurrent batch was still
  // writing pages (orphaning the late pages). Replaces the old isLastBatch /
  // 0.85-ratio early-claim shortcut.
  const crawlComplete =
    updatedJob.totalPages > 0 && updatedJob.crawledPages >= updatedJob.totalPages;
  if (!crawlComplete) {
    console.log(`[crawl] Batch ${batchIndex + 1}/${totalBatches} done. ${updatedJob.crawledPages}/${updatedJob.totalPages} crawled — waiting for all batches before scoring.`);
    return;
  }

  // Atomically claim the scoring transition — the winner (only one, via the
  // WHERE status='crawling' guard) dispatches scoring for every crawled page.
  const sql = neon(process.env.DATABASE_URL!);
  const claimed = await sql`
    UPDATE audit_jobs SET status = 'scoring'
    WHERE id = ${jobId} AND status = 'crawling'
    RETURNING id
  `;

  if (claimed.length === 0) {
    console.log(`[crawl] Job ${jobId} scoring already claimed by another batch — skipping.`);
    return;
  }

  const pages = await getPagesByJob(jobId);

  // If no pages were successfully crawled, finish now — nothing to score.
  // Distinguish a site that BLOCKS crawlers (raise an alert) from a genuinely
  // empty crawl (just mark done).
  if (pages.length === 0) {
    if (blockedCount > 0) {
      await updateJobStatus(jobId, "failed", {
        errorMessage: blockedMessage(lastBlockStatus),
      });
      console.warn(
        `[crawl] Job ${jobId}: 0 pages crawled, ${blockedCount} blocked — site blocks automated crawling.`
      );
    } else {
      await updateJobStatus(jobId, "done");
      console.log(`[crawl] Job ${jobId}: 0 pages in DB after crawl — marking done.`);
    }
    return;
  }

  console.log(`[crawl] Job ${jobId}: ${pages.length} pages in DB. Dispatching scoring...`);

  const SCORE_BATCH_SIZE = 10;
  for (let i = 0; i < pages.length; i += SCORE_BATCH_SIZE) {
    const chunk = pages.slice(i, i + SCORE_BATCH_SIZE);
    await enqueueScoreBatch({
      jobId,
      pageIds: chunk.map((p) => p.id),
      weights: { ...DEFAULT_WEIGHTS, ...updatedJob.weights } as DimensionScores,
    });
  }

  console.log(`[crawl] Job ${jobId}: ${Math.ceil(pages.length / SCORE_BATCH_SIZE)} score batches dispatched for ${pages.length} pages.`);
}

// ── Classify batch handler (backfill) ─────────────────────────
// Buckets already-scored pages that predate intent classification. Only
// touches classification columns — never re-scores. Failed pages stay
// NULL (unclassified) and can be retried by dispatching backfill again.

async function handleClassifyBatch(
  msg: ClassifyBatchMessage & { type: string }
): Promise<void> {
  const { jobId, pageIds } = msg;

  console.log(`[classify] Job ${jobId}: classifying ${pageIds.length} pages`);

  const allPages = await getPagesByJob(jobId);
  const pageMap = new Map(allPages.map((p) => [p.id, p]));

  const pagesToClassify = pageIds
    .map((id) => pageMap.get(id))
    .filter(Boolean)
    .map((p) => ({
      id: p!.id,
      url: p!.url,
      bodyText: p!.bodyText ?? "",
    }));

  if (pagesToClassify.length === 0) {
    console.warn(`[classify] Job ${jobId}: no matching pages for batch.`);
    return;
  }

  const results = await classifyBatch(pagesToClassify, jobId);

  for (const [pageId, c] of Array.from(results.entries())) {
    await updatePageClassification(pageId, {
      intentBuckets: c.intentBuckets,
      primaryBucket: c.primaryBucket,
      bucketEvidence: c.bucketEvidence as Record<string, string>,
    });
  }

  console.log(
    `[classify] Job ${jobId}: ${results.size}/${pagesToClassify.length} pages classified.`
  );
}

// ── Score batch handler ───────────────────────────────────────

async function handleScoreBatch(
  msg: ScoreBatchMessage & { type: string }
): Promise<void> {
  const { jobId, pageIds, weights } = msg;

  console.log(`[score] Job ${jobId}: scoring ${pageIds.length} pages`);

  const job = await getJob(jobId);
  if (!job || job.status === "failed") return;

  const allPages = await getPagesByJob(jobId);
  const pageMap = new Map(allPages.map((p) => [p.id, p]));

  const pagesToScore = pageIds
    .map((id) => pageMap.get(id))
    .filter(Boolean) as typeof allPages;

  if (pagesToScore.length === 0) {
    console.warn(`[score] Job ${jobId}: no matching pages for batch — checking completion.`);
    // Don't return early; fall through to the done check below
  }

  // Pass the FULL stored page to the scorer. Previously only body_text +
  // metadata were forwarded, so every page was scored with an empty title,
  // "(no headings found)", Word Count 0 and 0 links — starving the
  // Retrievable/Fan-out dimensions of data the crawler had already saved.
  const toCrawledPage = (p: StoredPage): CrawledPage => ({
    jobId,
    url: p.url,
    title: p.title,
    metaDescription: p.metaDescription,
    bodyText: p.bodyText,
    wordCount: p.wordCount,
    headings: p.headings,
    internalLinks: p.internalLinks,
    externalLinks: p.externalLinks,
    metadata: { hasStructuredData: false, ...(p.metadata as object) },
    httpStatus: p.httpStatus,
    crawledAt: new Date(),
  });

  // ── Determinism gate: reuse before re-scoring ───────────────
  // For each page, hash the exact scoring input. If an earlier run already
  // scored the identical input, copy that score verbatim (same numbers, same
  // rationale, same recommendations) — unchanged content can NEVER drift, and
  // it costs zero model calls. Only genuinely new/changed content is scored.
  const needsScoring: { page: CrawledPage; id: string; hash: string; serpContext: string | null }[] = [];
  let reused = 0;

  for (const p of pagesToScore) {
    const page = toCrawledPage(p);
    // Verified SERP context (latest stored snapshot for this URL, if any) is
    // part of the scoring input — and therefore of the content hash, so a
    // changed question set forces a versioned re-score instead of a silent
    // reuse against stale questions.
    const serpContext = await getSerpScoringContext(p.url);
    const hash = computeContentHash(page, weights as DimensionScores, serpContext);
    try {
      const prior = await findReusableScore(p.url, hash);
      if (prior) {
        await upsertScore({
          ...prior,
          id: crypto.randomUUID(),
          pageId: p.id,
          jobId,
          url: p.url,
          contentHash: hash,
          scoredAt: new Date(),
        });
        await incrementJobProgress(jobId, "scored_pages");
        reused++;
        continue;
      }
    } catch (err) {
      // Reuse is an optimization on top of correctness — on lookup failure,
      // fall through and score fresh rather than failing the batch.
      console.error(`[score] reuse lookup failed for ${p.url}:`, err);
    }
    needsScoring.push({ page, id: p.id, hash, serpContext });
  }

  if (reused > 0) {
    console.log(`[score] Job ${jobId}: reused ${reused} unchanged page score(s) via content hash.`);
  }

  const pageScoreList = await scoreBatch(
    needsScoring.map((c) => c.page),
    needsScoring.map((c) => c.id),
    weights as DimensionScores,
    async (_pageId) => {
      await incrementJobProgress(jobId, "scored_pages");
    },
    needsScoring.map((c) => c.hash),
    needsScoring.map((c) => c.serpContext)
  );

  for (const score of pageScoreList) {
    await upsertScore(score);
  }

  // Check if all pages are scored → mark job done
  // Use allPages.length (actual DB rows) NOT crawledPages counter, which counts failed fetches too
  // NOTE: compare countScoresByJob (real rows) NOT the scored_pages counter,
  // which can under-count under concurrent writes and strand a fully-scored
  // job in `scoring` forever (observed live: 10 rows written, counter read 0).
  const scoredRows = await countScoresByJob(jobId);
  const updatedJob = await getJob(jobId);
  if (updatedJob && allPages.length > 0 && scoredRows >= allPages.length) {
    await updateJobStatus(jobId, "done");
    console.log(`[score] Job ${jobId} complete! ${scoredRows}/${allPages.length} pages scored.`);

    const sql = neon(process.env.DATABASE_URL!);
    const jobRows = await sql`
      SELECT project_id, competitor_id FROM audit_jobs WHERE id = ${jobId}
    `;
    if (jobRows[0]?.project_id) {
      const { refreshProjectCache, refreshCompetitorCache } = await import("@/lib/db/projects");
      if (jobRows[0].competitor_id) {
        await refreshCompetitorCache(jobRows[0].competitor_id as string);
      } else {
        await refreshProjectCache(jobRows[0].project_id as string);

        // ── SERP visibility (AIO/PAA) detection ──────────────
        // Client jobs only for now (competitor overlap is Phase 5). Fully
        // env-gated: without SEMRUSH_API_KEY nothing is dispatched and the
        // audit pipeline is byte-for-byte unaffected.
        if (serpConfigured() || dfsConfigured()) {
          try {
            await dispatchSerpBatches(
              jobId,
              jobRows[0].project_id as string,
              allPages.map((p) => p.id)
            );
          } catch (err) {
            // SERP detection is additive — its dispatch failing must never
            // fail (and re-trigger) the scoring done-path.
            console.error(`[serp] Job ${jobId}: dispatch failed:`, err);
          }
        }
      }
    }
  }
}

// ── SERP visibility batch (AIO / PAA detection via Semrush) ──
// Verified SERP facts per page URL: which ranked keywords trigger an AI
// Overview / PAA box, and whether THIS url is cited in / owns them. Stored
// as per-(page,job) snapshots; monthly cache avoids re-spending API units.

const SERP_KEYWORDS_PER_URL = parseInt(process.env.SERP_KEYWORDS_PER_URL ?? "25", 10);
// Live Google SERP scrapes per page (DataForSEO): primary keyword + the
// highest-volume AIO-triggered keywords. Each scrape yields the AI Overview
// citation list, verbatim PAA questions with sources, and the organic top.
// Raised 3 → 6 (2026-07-26, Wayne-approved): PAA ownership can ONLY be
// resolved from a live scrape — DataForSEO's bulk ranked-keywords endpoint
// returns result elements only for organic/paid/featured_snippet/local_pack —
// so this number is the ceiling on how much of the PAA layer is measurable.
// Each extra keyword is a paid live SERP call; SERP_COST_CAP_USD still guards.
const SERP_LIVE_PER_PAGE = parseInt(process.env.SERP_LIVE_PER_PAGE ?? "6", 10);
// Per-run spend ceiling in USD for DataForSEO (real cost from API responses).
const SERP_COST_CAP_USD = parseFloat(process.env.SERP_COST_CAP_USD ?? "10");
const SERP_QUESTIONS_PER_PAGE = parseInt(process.env.SERP_QUESTIONS_PER_PAGE ?? "15", 10);
const SERP_UNIT_CAP_PER_RUN = parseInt(process.env.SERP_UNIT_CAP_PER_RUN ?? "15000", 10);

function normalizeQ(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Loose URL identity for "is this OUR page" checks: protocol, www, trailing
 * slash, and case differences don't make it a different page. (The crawl may
 * store https://iquanti.com/careers while Google cites
 * https://www.iquanti.com/careers/ — same page.)
 */
function urlKey(u: string): string {
  return u
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
}

async function handleSerpBatch(
  msg: SerpBatchMessage & { type: string }
): Promise<void> {
  const { jobId, pageIds, database } = msg;
  // Force refresh (2026-08-03): an explicit user action asking for live data
  // instead of this calendar month's cached copy. Never set by the automatic
  // post-scan dispatch — repeat runs stay free.
  const force = msg.force === true;

  if (!serpConfigured() && !dfsConfigured()) {
    console.warn(`[serp] Job ${jobId}: no SERP provider configured — skipping.`);
    return;
  }

  const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
  const jobRows = await sql`
    SELECT j.project_id, p.client_name
    FROM audit_jobs j JOIN projects p ON p.id = j.project_id
    WHERE j.id = ${jobId}
  `;
  if (!jobRows[0]?.project_id) {
    console.warn(`[serp] Job ${jobId}: no project — skipping.`);
    return;
  }
  const projectId = jobRows[0].project_id as string;
  const clientName = (jobRows[0].client_name as string) ?? "";

  const allPages = await getPagesByJob(jobId);
  const pageMap = new Map(allPages.map((p) => [p.id, p]));

  // Per-run unit budget: sum what this job's snapshots already spent.
  const spentRows = await sql`
    SELECT COALESCE(SUM(units_spent), 0)::int AS spent FROM serp_snapshots WHERE job_id = ${jobId}
  `.catch(() => [{ spent: 0 }] as Record<string, unknown>[]);
  let unitsSpent = (spentRows[0]?.spent as number) ?? 0;

  let done = 0;
  let cached = 0;
  let skipped = 0;

  for (const pageId of pageIds) {
    const page = pageMap.get(pageId);
    if (!page) continue;

    if (unitsSpent >= SERP_UNIT_CAP_PER_RUN) {
      skipped++;
      continue;
    }

    try {
      // Monthly cache: same URL+database this calendar month → copy, 0 units.
      // A forced refresh skips it outright and pays for live data.
      const prior = force ? null : await findMonthlySnapshot(page.url, database);
      if (prior) {
        await insertSnapshot({
          projectId,
          jobId,
          pageId,
          pageUrl: page.url,
          database,
          primaryKeyword: prior.primaryKeyword,
          unitsSpent: 0,
          reusedFrom: prior.id,
          volumesSemrush: prior.volumesSemrush,
          keywords: prior.keywords,
          questions: prior.questions,
          occupants: prior.occupants,
        });
        cached++;
        continue;
      }

      const useDfs = dfsConfigured();
      let rows;
      let kwUnits = 0;
      let costUsd = 0;
      let volumesSemrush = false;

      if (useDfs) {
        const res = await fetchUrlKeywordsDfs(page.url, database, SERP_KEYWORDS_PER_URL);
        rows = res.rows;
        costUsd += res.costUsd;
        // Ledger: DataForSEO returns its EXACT charged cost on every response.
        await recordApiCall({
          provider: "dataforseo",
          purpose: "serp_keywords",
          costUsd: res.costUsd,
          projectId,
          jobId,
          pageUrl: page.url,
          meta: { database, rows: res.rows.length },
        });
        // Volume correction (2026-07-25): Google Ads volumes (DFS Labs
        // keyword_info.search_volume) group close variants — every variant
        // inherits the cluster TOTAL (all "cd rates" phrasings showed 165K).
        // Replace with Semrush per-keyword volumes when the key is
        // configured; keywords Semrush doesn't know keep the DFS value.
        // Both sources are real data. A failure here keeps DFS volumes
        // rather than failing the page.
        if (serpConfigured() && rows.length > 0) {
          try {
            const vres = await fetchVolumesSemrush(
              rows.map((r) => r.keyword),
              database
            );
            if (vres.volumes.size > 0) {
              rows = rows.map((r) => ({
                ...r,
                volume: vres.volumes.get(r.keyword.trim().toLowerCase()) ?? r.volume,
              }));
              rows.sort((a, b) => b.volume - a.volume);
              volumesSemrush = true;
            }
            kwUnits += vres.unitsSpent;
            unitsSpent += vres.unitsSpent;
            await recordApiCall({
              provider: "semrush",
              purpose: "kw_volumes",
              costUsd: null,
              projectId,
              jobId,
              pageUrl: page.url,
              meta: { keywords: rows.length, units_spent: vres.unitsSpent },
            });
          } catch (err) {
            console.error(
              `[serp] Semrush volume override failed for ${page.url} — keeping DFS volumes:`,
              err
            );
          }
        }
      } else {
        const res = await fetchUrlKeywords(page.url, database, SERP_KEYWORDS_PER_URL);
        rows = res.rows;
        kwUnits = res.unitsSpent;
        unitsSpent += kwUnits;
        volumesSemrush = true; // Semrush-primary volumes are per-keyword already
        // Semrush bills in plan-dependent API units — record units, no $ guess.
        await recordApiCall({
          provider: "semrush",
          purpose: "serp_keywords",
          costUsd: null,
          projectId,
          jobId,
          pageUrl: page.url,
          meta: { database, rows: res.rows.length, units_spent: res.unitsSpent },
        });
      }

      const primaryKeyword = pickPrimaryKeyword(rows);
      const pageHost = new URL(page.url).hostname.replace(/^www\./, "");
      const headingText = (page.headings ?? [])
        .map((h: unknown) =>
          typeof h === "string" ? h : String((h as { text?: string })?.text ?? "")
        )
        .map(normalizeQ);

      let questions: {
        question: string;
        volume: number;
        covered: boolean;
        sourceUrl?: string;
        sourceDomain?: string;
      }[] = [];
      const occupants: OccupantInput[] = [];

      if (useDfs) {
        // Live SERPs: primary keyword first, then the biggest AIO-triggered
        // keywords — that is where "who is winning it" matters most.
        const targets: string[] = [];
        if (primaryKeyword) targets.push(primaryKeyword);
        for (const r of rows) {
          if (targets.length >= SERP_LIVE_PER_PAGE) break;
          if (r.aioTriggered && targets.indexOf(r.keyword) === -1) targets.push(r.keyword);
        }

        for (const kw of targets) {
          if (costUsd >= SERP_COST_CAP_USD) break;
          const live = await fetchSerpLiveDfs(kw, database);
          costUsd += live.costUsd;
          await recordApiCall({
            provider: "dataforseo",
            purpose: "serp_live",
            costUsd: live.costUsd,
            projectId,
            jobId,
            pageUrl: page.url,
            meta: { database, keyword: kw },
          });
          const row = rows.find((r) => r.keyword === kw);

          // AI Overview citations → occupants + refined cited flag.
          if (live.aioPresent && row) row.aioTriggered = true;
          live.aioRefs.forEach((ref, i) => {
            const isClient = ref.domain.replace(/^www\./, "") === pageHost;
            occupants.push({
              keyword: kw,
              feature: 52,
              rank: i + 1,
              domain: ref.domain,
              url: ref.url,
              title: ref.title,
              isClient,
            });
            if (isClient && row && urlKey(ref.url) === urlKey(page.url)) {
              row.aioCited = true;
            }
          });

          // Verbatim PAA questions (primary keyword feeds the question list).
          live.paaQuestions.forEach((q, i) => {
            const srcHost = q.sourceDomain.replace(/^www\./, "");
            const ownedByPage =
              srcHost === pageHost && urlKey(q.sourceUrl) === urlKey(page.url);
            if (row && q.question) row.paaPresent = true;
            if (ownedByPage && row) row.paaOwned = true;
            occupants.push({
              keyword: kw,
              feature: 21,
              rank: i + 1,
              domain: q.sourceDomain,
              url: q.sourceUrl,
              title: q.question,
              isClient: srcHost === pageHost,
            });
            if (kw === primaryKeyword && questions.length < SERP_QUESTIONS_PER_PAGE) {
              const nq = normalizeQ(q.question);
              questions.push({
                question: q.question,
                volume: 0, // live PAA boxes carry no volume; verbatim > volume here
                covered:
                  ownedByPage ||
                  headingText.some((h) => h.length > 0 && (h.includes(nq) || nq.includes(h))),
                sourceUrl: q.sourceUrl,
                sourceDomain: q.sourceDomain,
              });
            }
          });
        }
      } else if (primaryKeyword && unitsSpent < SERP_UNIT_CAP_PER_RUN) {
        // Semrush fallback: question-form queries as PAA proxy (no occupants).
        const q = await fetchQuestions(primaryKeyword, database, SERP_QUESTIONS_PER_PAGE);
        unitsSpent += q.unitsSpent;
        await recordApiCall({
          provider: "semrush",
          purpose: "serp_questions",
          costUsd: null,
          projectId,
          jobId,
          pageUrl: page.url,
          meta: { database, keyword: primaryKeyword, units_spent: q.unitsSpent },
        });
        const rankedSet = new Set(rows.map((r) => normalizeQ(r.keyword)));
        questions = q.rows.map((qr) => {
          const nq = normalizeQ(qr.question);
          const covered =
            rankedSet.has(nq) || headingText.some((h) => h.length > 0 && (h.includes(nq) || nq.includes(h)));
          return { question: qr.question, volume: qr.volume, covered };
        });
      }

      await insertSnapshot({
        projectId,
        jobId,
        pageId,
        pageUrl: page.url,
        database,
        primaryKeyword,
        unitsSpent: kwUnits,
        costUsd,
        volumesSemrush,
        keywords: rows.map((r) => ({
          ...r,
          branded: isBrandedKeyword(r.keyword, clientName),
        })),
        questions,
        occupants,
      });
      done++;
    } catch (err) {
      const emsg = String(err);
      // A dead key / zero unit balance fails every page identically — stop
      // the batch instead of burning retries page by page.
      if (/UNITS|WRONG KEY|LIMIT EXCEEDED|40100|40104|40200|40201|Payment Required|verify your account|credentials not set/i.test(emsg)) {
        console.error(`[serp] Job ${jobId}: SERP provider account error — stopping batch: ${emsg}`);
        return;
      }
      console.error(`[serp] ${page.url}:`, err);
    }
  }

  console.log(
    `[serp] Job ${jobId}: ${done} fetched, ${cached} cached, ${skipped} over-budget (units≈${unitsSpent}).`
  );

  // ── Verified-volume sweep ─────────────────────────────────
  // The volumes stored above are Google Ads figures, which share ONE cluster
  // total across close variants — unusable for any sum or weighting. This
  // replaces them with per-keyword volumes and flags the corrected rows.
  // Runs after each batch because SERP batches are chunked and independent
  // (there is no single "all pages done" moment to hang it on); the
  // keyword_volumes cache plus the volume_verified guard stop repeat sweeps
  // from re-spending. Fully caught — an unverified volume renders "—",
  // which is the correct outcome, and must never fail a webhook batch.
  try {
    const { sweepJobVolumes } = await import("@/lib/serp/volumes");
    await sweepJobVolumes(jobId, database);
  } catch (err) {
    console.error(`[volumes] Job ${jobId}: sweep hook failed:`, err);
  }
}

// ── LLM prompt-check batch handler ────────────────────────────
//
// One message = one or more prompts; each prompt is checked against every
// requested engine IN PARALLEL (live calls can take up to ~2 min each — the
// per-prompt wall time is the slowest engine, not the sum). Every row written
// comes from a real provider response or a real error; costs are what
// DataForSEO actually charged (recorded per call in the usage ledger).

async function handlePromptBatch(
  msg: PromptBatchMessage & { type: string }
): Promise<void> {
  const { projectId, runId, promptIds } = msg;
  const engines = (msg.engines ?? []).filter((e): e is PromptEngine =>
    (PROMPT_ENGINES as readonly string[]).includes(e)
  );
  if (engines.length === 0) return;

  const [project, prompts] = await Promise.all([
    getProject(projectId),
    getPromptsByIds(projectId, promptIds),
  ]);
  if (!project || prompts.length === 0) return;

  // Client identity for cited/brand detection — from the project record only.
  let clientHost = "";
  try {
    clientHost = new URL(project.websiteUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    /* keep empty — cited stays false rather than guessing */
  }
  const domainCore = clientHost.split(".")[0] ?? "";
  const brandTerms = [project.clientName?.trim(), domainCore]
    .filter((t): t is string => !!t && t.length >= 3);

  for (const prompt of prompts) {
    await Promise.all(
      engines.map(async (engine) => {
        try {
          const res = await runLlmPrompt(engine, prompt.prompt);

          // Cited = the engine's answer carries a citation link on the
          // client's host (urlKey-insensitive).
          let cited = false;
          let citedUrl: string | null = null;
          for (const c of res.citations) {
            try {
              const host = new URL(c.url).hostname.replace(/^www\./, "").toLowerCase();
              if (clientHost && (host === clientHost || host.endsWith(`.${clientHost}`))) {
                cited = true;
                if (!citedUrl) citedUrl = c.url;
              }
            } catch {
              /* unparsable citation URL — ignore */
            }
          }
          // Brand mention = client name (or domain core) appears in the
          // answer text. Simple case-insensitive containment — no inference.
          const answerLower = res.answer.toLowerCase();
          const brandMentioned = brandTerms.some((t) =>
            answerLower.includes(t.toLowerCase())
          );

          await insertPromptCheck({
            projectId,
            promptId: prompt.id,
            runId,
            engine,
            modelName: res.modelName,
            status: "ok",
            cited,
            citedUrl,
            brandMentioned,
            citations: res.citations.slice(0, 20) as PromptCitation[],
            answerExcerpt: res.answer.slice(0, 600),
            webSearch: res.webSearchUsed,
            costUsd: res.costUsd,
            error: null,
          });
          await recordApiCall({
            provider: "dataforseo",
            purpose: "llm_prompt",
            model: `${engine}/${res.modelName}`,
            costUsd: res.costUsd,
            projectId,
            meta: { engine, promptId: prompt.id, runId, cited, brandMentioned },
          });
        } catch (err) {
          const emsg = String((err as Error)?.message ?? err).slice(0, 300);
          console.error(`[prompts] ${engine} "${prompt.prompt.slice(0, 60)}":`, emsg);
          await insertPromptCheck({
            projectId,
            promptId: prompt.id,
            runId,
            engine,
            modelName: "",
            status: "error",
            cited: false,
            citedUrl: null,
            brandMentioned: false,
            citations: [],
            answerExcerpt: "",
            webSearch: false,
            costUsd: null,
            error: emsg,
          }).catch(() => undefined);
        }
      })
    );
  }
  // promptUrlKey imported for parity with serp handling; matching happens at
  // read time in lib/db/prompts.getPromptRowsForUrl.
  void promptUrlKey;
  console.log(
    `[prompts] Run ${runId}: checked ${prompts.length} prompt(s) × ${engines.length} engine(s).`
  );
}
