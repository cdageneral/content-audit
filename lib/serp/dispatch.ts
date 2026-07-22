// ─────────────────────────────────────────────────────────────
//  SERP batch dispatch — shared by the scoring done-path (auto)
//  and the manual /api/projects/[id]/serp trigger. Resolves the
//  project's regional Google database and chunks pages into
//  serp_batch QStash messages.
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import { enqueueSerpBatch } from "@/lib/queue/qstash";
import { serpDefaultDatabase } from "@/lib/serp/semrush";
import { ensureSerpSchema } from "@/lib/db/serp";

const SERP_PAGE_BATCH = 8;

export async function dispatchSerpBatches(
  jobId: string,
  projectId: string,
  pageIds: string[]
): Promise<number> {
  // serp_database lives behind the lazy DDL — make sure it exists before read.
  await ensureSerpSchema();
  const sql = neon(process.env.DATABASE_URL!, { fetchOptions: { cache: "no-store" } });
  const proj = await sql`
    SELECT serp_database FROM projects WHERE id = ${projectId}
  `.catch(() => [] as Record<string, unknown>[]);
  const database = (proj[0]?.serp_database as string) || serpDefaultDatabase();

  let batches = 0;
  for (let i = 0; i < pageIds.length; i += SERP_PAGE_BATCH) {
    await enqueueSerpBatch({
      jobId,
      pageIds: pageIds.slice(i, i + SERP_PAGE_BATCH),
      database,
    });
    batches++;
  }
  console.log(
    `[serp] Job ${jobId}: ${batches} serp batch(es) dispatched (${pageIds.length} pages, db=${database}).`
  );
  return batches;
}
