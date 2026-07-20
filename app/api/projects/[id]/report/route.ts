// ─────────────────────────────────────────────────────────────
//  GET /api/projects/[id]/report
//
//  Renders the C3-branded AI Content Readiness Assessment for the
//  project's latest completed run (client + competitors) and returns
//  it as a downloadable PDF (headless chromium). `?format=html`
//  returns the underlying HTML; if PDF generation fails, the route
//  falls back to HTML so the button always yields the report.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { getProjectDetail } from "@/lib/db/projects";
import { getScoresByJob } from "@/lib/db/client";
import {
  aggregateSite,
  renderAssessmentHtml,
  type ReportData,
  type SiteAggregate,
} from "@/lib/report/template";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const maxDuration = 120;

type Params = { params: { id: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const detail = await getProjectDetail(params.id);
    if (!detail) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Latest completed job per tracked site (same query the hub uses)
    const neon = (await import("@neondatabase/serverless")).neon;
    const sql = neon(process.env.DATABASE_URL!, {
      fetchOptions: { cache: "no-store" },
    });
    const latestJobs = await sql`
      SELECT DISTINCT ON (COALESCE(competitor_id::text, 'client'))
        id, competitor_id, completed_at
      FROM audit_jobs
      WHERE project_id = ${params.id} AND status = 'done'
      ORDER BY COALESCE(competitor_id::text, 'client'), completed_at DESC
    `;

    let client: SiteAggregate | null = null;
    let clientJobId: string | null = null;
    let runDate: Date | null = null;
    const competitors: SiteAggregate[] = [];

    for (const job of latestJobs) {
      const scores = await getScoresByJob(job.id as string);
      if (!scores.length) continue;
      if (job.competitor_id == null) {
        client = aggregateSite("client", detail.clientName, detail.websiteUrl, scores);
        clientJobId = job.id as string;
        runDate = job.completed_at ? new Date(job.completed_at as string) : null;
      } else {
        const comp = detail.competitors.find((c) => c.id === String(job.competitor_id));
        if (comp) {
          const agg = aggregateSite(comp.id, comp.name, comp.url, scores);
          if (agg) competitors.push(agg);
        }
      }
    }

    if (!client) {
      return NextResponse.json(
        { error: "No completed audit run yet — run an audit first, then download the assessment." },
        { status: 409 }
      );
    }
    competitors.sort((a, b) => b.overall - a.overall);

    // AI-crawler access from the client's latest checked run. Separate,
    // error-tolerant query: the ai_access column is created lazily, so a DB
    // that predates the feature must not break report generation.
    let aiAccess: ReportData["aiAccess"] = null;
    const accessRows = await sql`
      SELECT ai_access FROM audit_jobs
      WHERE project_id = ${params.id} AND competitor_id IS NULL AND ai_access IS NOT NULL
      ORDER BY created_at DESC LIMIT 1
    `.catch(() => [] as Record<string, unknown>[]);
    aiAccess = (accessRows[0]?.ai_access as ReportData["aiAccess"]) ?? null;

    const data: ReportData = {
      project: detail,
      client,
      competitors,
      generatedAt: new Date(),
      runDate,
      jobId: clientJobId,
      modelVersion: client.pages[0]?.modelVersion ?? null,
      aiAccess,
    };

    const html = renderAssessmentHtml(data);

    const wantHtml = req.nextUrl.searchParams.get("format") === "html";
    const safeName = detail.clientName.replace(/[^a-zA-Z0-9-_ ]/g, "").replace(/\s+/g, "-");
    const dateTag = (runDate ?? new Date()).toISOString().slice(0, 10);

    if (!wantHtml) {
      try {
        const pdf = await htmlToPdf(html);
        return new NextResponse(new Uint8Array(pdf), {
          headers: {
            "Content-Type": "application/pdf",
            "Content-Disposition": `attachment; filename="AI-Content-Assessment-${safeName}-${dateTag}.pdf"`,
            "Cache-Control": "no-store",
          },
        });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        console.error(
          "[report] PDF generation failed, serving HTML fallback. Error tail:",
          msg.length > 900 ? "…" + msg.slice(-900) : msg
        );
        // fall through to HTML
      }
    }

    return new NextResponse(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        ...(wantHtml
          ? {}
          : {
              "Content-Disposition": `inline; filename="AI-Content-Assessment-${safeName}-${dateTag}.html"`,
              "X-Report-Fallback": "pdf-failed",
            }),
      },
    });
  } catch (err) {
    console.error(`[api/projects/${params.id}/report]`, err);
    return NextResponse.json({ error: "Failed to generate assessment" }, { status: 500 });
  }
}

// ── HTML → PDF via playwright-core + @sparticuz/chromium ──────
// Same launch pattern as lib/crawler/extract.ts (already proven on Vercel).

async function htmlToPdf(html: string): Promise<Buffer> {
  // Vercel masks AWS_EXECUTION_ENV, so @sparticuz/chromium's lambda detection
  // fails: it extracts the chromium binary but SKIPS the bundled shared
  // libraries (libnss3.so etc.) and never sets LD_LIBRARY_PATH — chromium
  // then dies at launch with "error while loading shared libraries".
  // Force the Netlify-style runtime flag (checked at executablePath() time)
  // and set LD_LIBRARY_PATH ourselves (normally a module-load side effect,
  // which is skipped when the import is already cached).
  if (!process.env["AWS_EXECUTION_ENV"] && !process.env["AWS_LAMBDA_JS_RUNTIME"]) {
    process.env["AWS_LAMBDA_JS_RUNTIME"] = "nodejs22.x";
  }
  const baseLib = "/tmp/al2023/lib";
  if (process.env["LD_LIBRARY_PATH"]?.startsWith(baseLib) !== true) {
    process.env["LD_LIBRARY_PATH"] = [baseLib, process.env["LD_LIBRARY_PATH"] ?? ""]
      .filter(Boolean)
      .join(":");
  }

  const { chromium } = await import("playwright-core");
  const chromiumModule = await import("@sparticuz/chromium");

  const browser = await chromium.launch({
    args: chromiumModule.default.args,
    executablePath: await chromiumModule.default.executablePath(),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    // Fully server-rendered HTML — no scripts to wait for.
    await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
    await page.emulateMedia({ media: "print" });
    const pdf = await page.pdf({
      width: "8.5in",
      height: "11in",
      printBackground: true,
      margin: { top: "0", bottom: "0", left: "0", right: "0" },
    });
    return pdf;
  } finally {
    await browser.close().catch(() => undefined);
  }
}
