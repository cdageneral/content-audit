// /api/audit/[jobId]/classify
//   POST — dispatch classification-only backfill batches for every scored
//          page in this job that has never been bucketed (intent_buckets NULL)
//   GET  — {total, classified} progress the UI polls while backfill runs
//
// Classification never re-scores: it only fills the intent-bucket columns on
// existing page_scores rows, so it is safe (and cheap) on old audits.

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

import { NextRequest, NextResponse } from "next/server";
import {
  getUnclassifiedPagesForJob,
  getClassificationStatus,
} from "@/lib/db/client";
import { enqueueClassifyBatch } from "@/lib/queue/qstash";

const CLASSIFY_BATCH_SIZE = 10;

export async function POST(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const pages = await getUnclassifiedPagesForJob(params.jobId);

    if (pages.length === 0) {
      const status = await getClassificationStatus(params.jobId);
      return NextResponse.json({ dispatched: 0, ...status });
    }

    for (let i = 0; i < pages.length; i += CLASSIFY_BATCH_SIZE) {
      await enqueueClassifyBatch({
        jobId: params.jobId,
        pageIds: pages.slice(i, i + CLASSIFY_BATCH_SIZE).map((p) => p.id),
      });
    }

    const status = await getClassificationStatus(params.jobId);
    return NextResponse.json({ dispatched: pages.length, ...status });
  } catch (err) {
    console.error(`[classify] Dispatch failed for job ${params.jobId}:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  try {
    const status = await getClassificationStatus(params.jobId);
    return NextResponse.json(status);
  } catch (err) {
    console.error(`[classify] Status failed for job ${params.jobId}:`, err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
