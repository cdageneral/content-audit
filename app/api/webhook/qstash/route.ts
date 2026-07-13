// POST /api/webhook/qstash
// Receives async batch jobs from QStash: crawl_batch and score_batch
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { verifyQStashSignature } from "@/lib/queue/qstash";
import { extractPage } from "@/lib/crawler/extract";
import { scoreBatch } from "@/lib/scoring";
import {
  upsertPage,
  upsertScore,
  getPagesByJob,
  updateJobStatus,
  incrementJobProgress,
  getJob,
} from "@/lib/db/client";
import { enqueueScoreBatch } from "@/lib/queue/qstash";
import { neon } from "@neondatabase/serverless";
import type { CrawlBatchMessage, ScoreBatchMessage, DimensionScores } from "@/lib/types";
import { DEFAULT_WEIGHTS } from "@/lib/types";

// Threshold: if ≥85% of pages crawled, don't wait for the final batch index
const CRAWL_COMPLETION_THRESHOLD = 0.85;

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

  const job = await getJob(jobId);
  if (!job || job.status === "failed" || job.status === "scoring" || job.status === "done") return;

  for (const url of urls) {
    try {
      const page = await extractPage(jobId, url, {
        usePlaywright: false,
        auth: auth ?? undefined,
      });
      if (page) {
        await upsertPage(page);
        console.log(`[crawl] ✓ ${url}`);
      } else {
        console.warn(`[crawl] ✗ ${url}: returned null (blocked or empty)`);
      }
    } catch (err) {
      console.error(`[crawl] ✗ ${url}:`, err);
    } finally {
      // Always count as attempted — blocked/timed-out pages must not stall the pipeline
      await incrementJobProgress(jobId, "crawled_pages");
    }
  }

  // Re-fetch job to get latest crawled count after this batch
  const updatedJob = await getJob(jobId);
  if (!updatedJob || updatedJob.status !== "crawling") return;

  const isLastBatch = batchIndex === totalBatches - 1;
  const crawlRatio = updatedJob.totalPages > 0
    ? updatedJob.crawledPages / updatedJob.totalPages
    : 0;
  const enoughCrawled = crawlRatio >= CRAWL_COMPLETION_THRESHOLD;

  if (!isLastBatch && !enoughCrawled) {
    console.log(`[crawl] Batch ${batchIndex + 1}/${totalBatches} done. ${updatedJob.crawledPages}/${updatedJob.totalPages} crawled (${Math.round(crawlRatio * 100)}%) — waiting for more batches.`);
    return;
  }

  // Atomically claim the scoring transition — prevents duplicate scoring if
  // multiple batches finish around the same time
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

  // If no pages were successfully crawled, mark done immediately — nothing to score
  if (pages.length === 0) {
    await updateJobStatus(jobId, "done");
    console.log(`[crawl] Job ${jobId}: 0 pages in DB after crawl — marking done.`);
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

  const crawledPages = pagesToScore.map((p) => ({
    jobId,
    url: p.url,
    title: "",
    metaDescription: "",
    bodyText: p.bodyText ?? "",
    wordCount: 0,
    headings: [],
    internalLinks: [],
    externalLinks: [],
    metadata: { hasStructuredData: false, ...(p.metadata as object) },
    httpStatus: 200,
    crawledAt: new Date(),
  }));

  const pageScoreList = await scoreBatch(
    crawledPages,
    pagesToScore.map((p) => p.id),
    weights as DimensionScores,
    async (_pageId) => {
      await incrementJobProgress(jobId, "scored_pages");
    }
  );

  for (const score of pageScoreList) {
    await upsertScore(score);
  }

  // Check if all pages are scored → mark job done
  // Use allPages.length (actual DB rows) NOT crawledPages counter, which counts failed fetches too
  const updatedJob = await getJob(jobId);
  if (updatedJob && allPages.length > 0 && updatedJob.scoredPages >= allPages.length) {
    await updateJobStatus(jobId, "done");
    console.log(`[score] Job ${jobId} complete! ${updatedJob.scoredPages}/${allPages.length} pages scored.`);

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
      }
    }
  }
}
