// POST /api/audit — Create a new audit job
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createJob, updateJobStatus } from "@/lib/db/client";
import { discoverUrls } from "@/lib/crawler/discover";
import { enqueueCrawlBatches } from "@/lib/queue/qstash";
import { DEFAULT_WEIGHTS } from "@/lib/types";

const CreateAuditSchema = z.object({
  url: z.string().url("Must be a valid URL"),
  scopePrefix: z.string().optional(),
  maxPages: z.number().int().min(1).max(5000).optional().default(500),
  auth: z
    .object({
      type: z.enum(["none", "cookie", "bearer", "basic"]),
      cookie: z.string().optional(),
      token: z.string().optional(),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional(),
  weights: z.record(z.number().min(0).max(1)).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = CreateAuditSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const input = parsed.data;

    // 1. Create job record
    const job = await createJob({
      url: input.url,
      scopePrefix: input.scopePrefix,
      maxPages: input.maxPages,
      auth: input.auth,
      weights: { ...DEFAULT_WEIGHTS, ...input.weights },
    });

    // 2. Discover URLs (fast phase — uses sitemap or quick BFS)
    await updateJobStatus(job.id, "discovering");

    const urls = await discoverUrls({
      rootUrl: input.url,
      scopePrefix: input.scopePrefix,
      maxPages: input.maxPages,
      auth: input.auth,
    });

    if (urls.length === 0) {
      await updateJobStatus(job.id, "failed", {
        errorMessage: "No URLs discovered. Check the URL and scope prefix.",
      });
      return NextResponse.json(
        { error: "No URLs discovered", jobId: job.id },
        { status: 422 }
      );
    }

    // 3. Update total page count and move to crawling status
    await updateJobStatus(job.id, "crawling", { totalPages: urls.length });

    // 4. Dispatch crawl batches to QStash
    const totalBatches = await enqueueCrawlBatches(job.id, urls, input.auth ?? null);

    console.log(
      `[audit] Job ${job.id} created: ${urls.length} URLs → ${totalBatches} batches`
    );

    return NextResponse.json({
      jobId: job.id,
      status: "crawling",
      totalPages: urls.length,
      totalBatches,
    });
  } catch (err) {
    console.error("[api/audit POST]", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

// GET /api/audit — List recent audit jobs
export async function GET() {
  try {
    const { listJobs } = await import("@/lib/db/client");
    const jobs = await listJobs(20);
    return NextResponse.json({ jobs });
  } catch (err) {
    console.error("[api/audit GET]", err);
    return NextResponse.json({ error: "Failed to list jobs" }, { status: 500 });
  }
}
