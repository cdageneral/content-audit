// POST /api/webhook/qstash
// Receives async batch jobs from QStash: crawl_batch and score_batch
// maxDuration: 300 (set in vercel.json)
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
import type { CrawlBatchMessage, ScoreBatchMessage, DimensionScores } from "@/lib/types";
import { DEFAULT_WEIGHTS } from "@/lib/types";

export async function POST(req: NextRequest) {
  // Verify the request is from QStash
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
    } else {
      console.warn(`[qstash] Unknown message type: ${msg.type}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[qstash] Handler error:", err);
    // Return 200 to prevent QStash from retrying fatally broken jobs
    return NextResponse.json({ error: String(err) }, { status: 200 });
  }
}

// ── Crawl batch handler ───────────────────────────────────────

async function handleCrawlBatch(
  msg: CrawlBatchMessage & { type: string }
): Promise<void> {
  const { jobId, urls, auth, batchIndex, totalBatches } = msg;

  console.log(
    `[crawl] Job ${jobId}: batch ${batchIndex + 1}/${totalBatches} (${urls.length} URLs)`
  );

  const job = await getJob(jobId);
  if (!job || job.status === "failed") return;

  const pageIds: string[] = [];

  for (const url of urls) {
    try {
      const page = await extractPage(jobId, url, {
        usePlaywright: false, // Start with fetch; upgrade to Playwright if needed
        auth: auth ?? undefined,
      });

      if (page) {
        const pageId = await upsertPage(page);
        pageIds.push(pageId);
        await incrementJobProgress(jobId, "crawled_pages");
        console.log(`[crawl] ✓ ${url}`);
      }
    } catch (err) {
      console.error(`[crawl] ✗ ${url}:`, err);
    }
  }

  // On the final batch, kick off scoring
  if (batchIndex === totalBatches - 1) {
    console.log(`[crawl] All batches complete for job ${jobId}. Starting scoring...`);
    await updateJobStatus(jobId, "scoring");

    // Fetch all crawled page IDs and dispatch scoring
    const pages = await getPagesByJob(jobId);
    const SCORE_BATCH_SIZE = 10;

    for (let i = 0; i < pages.length; i += SCORE_BATCH_SIZE) {
      const chunk = pages.slice(i, i + SCORE_BATCH_SIZE);
      await enqueueScoreBatch({
        jobId,
        pageIds: chunk.map((p) => p.id),
        weights: job.weights,
      });
    }
  }
}

// ── Score batch handler ───────────────────────────────────────

async function handleScoreBatch(
  msg: ScoreBatchMessage & { type: string }
): Promise<void> {
  const { jobId, pageIds, weights } = msg;

  console.log(`[score] Job ${jobId}: scoring ${pageIds.length} pages`);

  const job = await getJob(jobId);
  if (!job || job.status === "failed") return;

  // Load page content from DB
  const allPages = await getPagesByJob(jobId);
  const pageMap = new Map(allPages.map((p) => [p.id, p]));

  const pagesToScore = pageIds
    .map((id) => pageMap.get(id))
    .filter(Boolean) as typeof allPages;

  if (pagesToScore.length === 0) return;

  // Build CrawledPage-compatible objects for the scorer
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
    metadata: {
      hasStructuredData: false,
      ...(p.metadata as object),
    },
    httpStatus: 200,
    crawledAt: new Date(),
  }));

  const pageScoreList = await scoreBatch(
    crawledPages,
    pagesToScore.map((p) => p.id),
    weights as DimensionScores,
    async (pageId) => {
      await incrementJobProgress(jobId, "scored_pages");
    }
  );

  // Persist scores
  for (const score of pageScoreList) {
    await upsertScore(score);
  }

  // Check if all pages are scored → mark job done
  const updatedJob = await getJob(jobId);
  if (updatedJob && updatedJob.scoredPages >= updatedJob.totalPages) {
    await updateJobStatus(jobId, "done");
    console.log(`[score] Job ${jobId} complete!`);

    // Refresh project / competitor caches if this job is linked to a project
    const neon = (await import("@neondatabase/serverless")).neon;
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
