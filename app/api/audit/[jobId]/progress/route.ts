// GET /api/audit/[jobId]/progress — Server-Sent Events stream
// Clients connect here to get real-time job progress updates
import { NextRequest } from "next/server";
import { getJob } from "@/lib/db/client";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        const payload = `data: ${JSON.stringify(data)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      // Poll job state every 2 seconds and stream updates
      let previousStatus = "";
      let consecutive404 = 0;

      const interval = setInterval(async () => {
        try {
          const job = await getJob(jobId);

          if (!job) {
            consecutive404++;
            if (consecutive404 >= 3) {
              send({ error: "Job not found" });
              clearInterval(interval);
              controller.close();
            }
            return;
          }

          consecutive404 = 0;

          send({
            jobId: job.id,
            status: job.status,
            totalPages: job.totalPages,
            crawledPages: job.crawledPages,
            scoredPages: job.scoredPages,
            errorMessage: job.errorMessage,
          });

          // Close stream when job reaches terminal state
          if (job.status === "done" || job.status === "failed") {
            clearInterval(interval);
            setTimeout(() => controller.close(), 500);
          }

          previousStatus = job.status;
        } catch (err) {
          console.error(`[SSE] Error fetching job ${jobId}:`, err);
          send({ error: "Polling error" });
        }
      }, 2000);

      // Send initial state immediately
      try {
        const job = await getJob(jobId);
        if (job) {
          send({
            jobId: job.id,
            status: job.status,
            totalPages: job.totalPages,
            crawledPages: job.crawledPages,
            scoredPages: job.scoredPages,
          });
        }
      } catch {
        // ignore initial fetch error
      }

      // Clean up on client disconnect
      _req.signal.addEventListener("abort", () => {
        clearInterval(interval);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
