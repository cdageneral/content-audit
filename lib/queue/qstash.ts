// ─────────────────────────────────────────────────────────────
//  QStash queue client — fire-and-forget async batches
//  Bypasses Vercel's 300s function timeout for large crawls
// ─────────────────────────────────────────────────────────────

import { Client, Receiver } from "@upstash/qstash";
import type {
  CrawlBatchMessage,
  ScoreBatchMessage,
  ClassifyBatchMessage,
} from "@/lib/types";

function getClient() {
  if (!process.env.QSTASH_TOKEN) throw new Error("QSTASH_TOKEN not set");
  return new Client({ token: process.env.QSTASH_TOKEN });
}

function getBaseUrl(): string {
  const url = process.env.NEXT_PUBLIC_APP_URL;
  if (!url) throw new Error("NEXT_PUBLIC_APP_URL not set");
  return url.replace(/\/$/, "");
}

// ── Dispatch a crawl batch ────────────────────────────────────

export async function enqueueCrawlBatch(msg: CrawlBatchMessage): Promise<void> {
  const client = getClient();
  const endpoint = `${getBaseUrl()}/api/webhook/qstash`;

  await client.publishJSON({
    url: endpoint,
    body: { type: "crawl_batch", ...msg },
    retries: 2,
    delay: 0,
  });
}

// ── Dispatch multiple crawl batches ──────────────────────────

export async function enqueueCrawlBatches(
  jobId: string,
  urls: string[],
  auth: CrawlBatchMessage["auth"],
  batchSize = parseInt(process.env.BATCH_SIZE ?? "15", 10)
): Promise<number> {
  const batches = chunk(urls, batchSize);
  const totalBatches = batches.length;

  for (let i = 0; i < batches.length; i++) {
    await enqueueCrawlBatch({
      jobId,
      urls: batches[i],
      auth,
      batchIndex: i,
      totalBatches,
    });
    // Small delay between dispatches to avoid QStash ingestion spikes
    if (i < batches.length - 1) await sleep(100);
  }

  return totalBatches;
}

// ── Dispatch a scoring batch ──────────────────────────────────

export async function enqueueScoreBatch(msg: ScoreBatchMessage): Promise<void> {
  const client = getClient();
  const endpoint = `${getBaseUrl()}/api/webhook/qstash`;

  await client.publishJSON({
    url: endpoint,
    body: { type: "score_batch", ...msg },
    retries: 2,
    delay: 2, // 2s delay to let DB writes settle
  });
}

// ── Dispatch a SERP-visibility batch (AIO/PAA detection) ─────

export interface SerpBatchMessage {
  jobId: string;
  pageIds: string[];
  database: string;
}

export async function enqueueSerpBatch(msg: SerpBatchMessage): Promise<void> {
  const client = getClient();
  const endpoint = `${getBaseUrl()}/api/webhook/qstash`;

  await client.publishJSON({
    url: endpoint,
    body: { type: "serp_batch", ...msg },
    retries: 2,
    delay: 2,
  });
}

// ── Dispatch a classification-only batch (backfill) ───────────

export async function enqueueClassifyBatch(msg: ClassifyBatchMessage): Promise<void> {
  const client = getClient();
  const endpoint = `${getBaseUrl()}/api/webhook/qstash`;

  await client.publishJSON({
    url: endpoint,
    body: { type: "classify_batch", ...msg },
    retries: 2,
    delay: 0,
  });
}

// ── Verify QStash webhook signature ──────────────────────────

export async function verifyQStashSignature(
  req: Request
): Promise<{ valid: boolean; body: unknown }> {
  const signingKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;

  if (!signingKey || !nextSigningKey) {
    throw new Error("QStash signing keys not set");
  }

  const receiver = new Receiver({
    currentSigningKey: signingKey,
    nextSigningKey: nextSigningKey,
  });

  const bodyText = await req.text();
  const signature = req.headers.get("upstash-signature") ?? "";

  const isValid = await receiver
    .verify({ signature, body: bodyText })
    .catch(() => false);

  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }

  return { valid: isValid, body };
}

// ── Utilities ─────────────────────────────────────────────────

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
