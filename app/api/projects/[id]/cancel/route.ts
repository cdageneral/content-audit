// POST /api/projects/[id]/cancel — Mark all active jobs for a project as failed
import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const sql = neon(process.env.DATABASE_URL!);
    const result = await sql`
      UPDATE audit_jobs
      SET status = 'failed', error_message = 'Cancelled by user'
      WHERE project_id = ${params.id}
        AND status NOT IN ('done', 'failed')
      RETURNING id
    `;
    return NextResponse.json({ cancelled: result.length, ids: result.map((r) => r.id) });
  } catch (err) {
    console.error(`[cancel]`, err);
    return NextResponse.json({ error: "Failed to cancel jobs" }, { status: 500 });
  }
}
