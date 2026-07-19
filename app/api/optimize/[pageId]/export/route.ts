// ─────────────────────────────────────────────────────────────
//  GET /api/optimize/[pageId]/export?draftId=…&simulationId=…
//  Implementation packet (.docx): the final optimized copy, a
//  change summary, the baseline-vs-simulated score table, an
//  implementation checklist, and the methodology stamp — the
//  deliverable a client hands to whoever publishes the change.
// ─────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from "next/server";
import { neon } from "@neondatabase/serverless";
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
} from "docx";
import { getDraft, getSimulation, getPageForOptimize } from "@/lib/db/drafts";
import { draftToCrawledPage } from "@/lib/optimize/transform";
import { ALL_DIMENSIONS, DIMENSION_LABELS, DEFAULT_WEIGHTS } from "@/lib/types";
import type { DimensionScores, ScoreDimension } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type Params = { params: { pageId: string } };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const draftId = req.nextUrl.searchParams.get("draftId") ?? "";
    const simulationId = req.nextUrl.searchParams.get("simulationId") ?? "";
    if (!draftId) {
      return NextResponse.json({ error: "draftId is required" }, { status: 400 });
    }

    const [draft, simulation, bundle] = await Promise.all([
      getDraft(draftId),
      simulationId ? getSimulation(simulationId) : Promise.resolve(null),
      getPageForOptimize(params.pageId),
    ]);
    if (!draft || draft.pageId !== params.pageId || !bundle) {
      return NextResponse.json({ error: "Draft or page not found" }, { status: 404 });
    }

    // Baseline score row for the comparison table
    const baseline = await loadBaseline(params.pageId);

    // Derived stats for the change summary (crawler-parity formulas)
    const simPage = draftToCrawledPage(
      bundle.jobId,
      bundle.page.url,
      {
        title: draft.title,
        metaDescription: draft.metaDescription,
        bodyMd: draft.bodyMd,
        metadata: draft.metadata,
        internalLinks: draft.internalLinks,
        externalLinks: draft.externalLinks,
      },
      bundle.page.httpStatus
    );

    const doc = buildDocument({
      url: bundle.page.url,
      draft,
      simulation,
      baseline,
      before: {
        title: bundle.page.title,
        metaDescription: bundle.page.metaDescription,
        wordCount: bundle.page.wordCount,
        headings: bundle.page.headings.length,
        internalLinks: bundle.page.internalLinks.length,
        externalLinks: bundle.page.externalLinks.length,
      },
      after: {
        title: simPage.title,
        metaDescription: simPage.metaDescription,
        wordCount: simPage.wordCount,
        headings: simPage.headings.length,
        internalLinks: simPage.internalLinks.length,
        externalLinks: simPage.externalLinks.length,
      },
    });

    const buffer = await Packer.toBuffer(doc);
    const slug =
      bundle.page.url
        .replace(/^https?:\/\//, "")
        .replace(/[^a-zA-Z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 60) || "page";

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="optimized-${slug}-v${draft.version}.docx"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error(`[api/optimize/${params.pageId}/export GET]`, err);
    return NextResponse.json({ error: "Export failed" }, { status: 500 });
  }
}

// ── Baseline lookup ───────────────────────────────────────────

interface BaselineRow {
  scores: DimensionScores;
  overallScore: number;
  grade: string;
  modelVersion: string;
  scoredAt: string;
}

async function loadBaseline(pageId: string): Promise<BaselineRow | null> {
  if (!process.env.DATABASE_URL) return null;
  const sql = neon(process.env.DATABASE_URL, { fetchOptions: { cache: "no-store" } });
  const rows = await sql`
    SELECT * FROM page_scores
    WHERE page_id = ${pageId} AND model_version <> 'error'
    ORDER BY scored_at DESC LIMIT 1
  `.catch(() => [] as Record<string, unknown>[]);
  const r = rows[0];
  if (!r) return null;
  return {
    scores: {
      coreIntent: r.score_core_intent as number,
      edgeCases: r.score_edge_cases as number,
      impliedQuestions: r.score_implied_questions as number,
      fanOutQueries: r.score_fan_out_queries as number,
      retrievable: r.score_retrievable as number,
      extractable: r.score_extractable as number,
      citable: r.score_citable as number,
      reusable: r.score_reusable as number,
    },
    overallScore: r.overall_score as number,
    grade: r.grade as string,
    modelVersion: r.model_version as string,
    scoredAt: String(r.scored_at ?? ""),
  };
}

// ── Document builder ──────────────────────────────────────────

interface BuildInput {
  url: string;
  draft: NonNullable<Awaited<ReturnType<typeof getDraft>>>;
  simulation: Awaited<ReturnType<typeof getSimulation>>;
  baseline: BaselineRow | null;
  before: SnapshotStats;
  after: SnapshotStats;
}

interface SnapshotStats {
  title: string;
  metaDescription: string;
  wordCount: number;
  headings: number;
  internalLinks: number;
  externalLinks: number;
}

function buildDocument(input: BuildInput): Document {
  const { url, draft, simulation, baseline, before, after } = input;

  const children: (Paragraph | Table)[] = [];

  // Header
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun("Content Optimization Packet")],
    }),
    para(url, { italics: true }),
    para(
      `Draft v${draft.version} · saved ${draft.createdAt.toISOString().slice(0, 10)}`,
      { color: "666666" }
    ),
    new Paragraph({ text: "" })
  );

  // Score comparison
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Projected Score Impact")],
    })
  );
  if (baseline && simulation) {
    children.push(
      para(
        `Overall: ${baseline.overallScore} (${baseline.grade}) → ${simulation.overallScore} (${simulation.grade})` +
          `  ·  ${delta(simulation.overallScore - baseline.overallScore)}`,
        { bold: true }
      ),
      scoreTable(baseline.scores, simulation.scores),
      new Paragraph({ text: "" })
    );
  } else if (simulation) {
    children.push(
      para(
        `Simulated score: ${simulation.overallScore} (${simulation.grade}). No baseline audit row was available for comparison.`
      )
    );
  } else {
    children.push(
      para(
        "No simulation was run for this draft. Scores below reflect the baseline audit only.",
        { italics: true }
      )
    );
    if (baseline) {
      children.push(scoreTable(baseline.scores, null), new Paragraph({ text: "" }));
    }
  }

  // Change summary
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Change Summary")],
    })
  );
  const changes: string[] = [];
  if (before.title !== after.title) {
    changes.push(`Title: "${before.title}" → "${after.title}"`);
  }
  if (before.metaDescription !== after.metaDescription) {
    changes.push(`Meta description updated (${after.metaDescription.length} chars).`);
  }
  changes.push(
    `Word count: ${before.wordCount} → ${after.wordCount} (${delta(after.wordCount - before.wordCount)})`,
    `Headings: ${before.headings} → ${after.headings}`,
    `Internal links: ${before.internalLinks} → ${after.internalLinks}`,
    `External links: ${before.externalLinks} → ${after.externalLinks}`
  );
  for (const c of changes) children.push(bullet(c));
  children.push(new Paragraph({ text: "" }));

  // Implementation checklist
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Implementation Checklist")],
    })
  );
  const checklist = [
    `Replace the page body at ${url} with the "Optimized Content" section below, preserving the heading levels exactly (## = H2, ### = H3).`,
    `Set the page title to: ${after.title || "(unchanged)"}`,
    `Set the meta description to: ${after.metaDescription || "(unchanged)"}`,
    draft.metadata.author
      ? `Ensure the page shows author attribution: ${draft.metadata.author}`
      : "Consider adding visible author attribution (improves Citable).",
    draft.metadata.publishedDate || draft.metadata.modifiedDate
      ? "Ensure published/updated dates are present in the page markup."
      : "Consider adding a visible published/updated date (improves Citable).",
    "Resolve every [ADD: …] placeholder with your real data before publishing — placeholders mark spots where specific facts belong.",
    "Publish, then re-run the audit for this URL. If the page was implemented as specified, the new audited score will match the simulated score above.",
  ];
  for (const c of checklist) children.push(bullet(c));
  children.push(new Paragraph({ text: "" }));

  // Final copy
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Optimized Content")],
    })
  );
  for (const p of markdownToParagraphs(draft.bodyMd)) children.push(p);

  // Methodology stamp
  children.push(
    new Paragraph({ text: "" }),
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun("Methodology")],
    }),
    para(
      simulation
        ? `Simulated with the production scoring engine: model ${simulation.modelVersion}, prompt ${simulation.promptVersion}, temperature 0, baseline run weights. Content fingerprint: ${simulation.contentHash.slice(0, 16)}…. Simulations are deterministic: publishing this content unchanged reproduces the simulated scores on the next audit of this URL.`
        : `Baseline audit model: ${baseline?.modelVersion ?? "n/a"}.`,
      { color: "666666" }
    )
  );

  return new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 22 } },
      },
    },
    sections: [{ children }],
  });
}

// ── Helpers ───────────────────────────────────────────────────

function para(
  text: string,
  opts: { bold?: boolean; italics?: boolean; color?: string } = {}
): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text, bold: opts.bold, italics: opts.italics, color: opts.color })],
  });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    children: [new TextRun(text)],
    bullet: { level: 0 },
  });
}

function delta(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function cell(text: string, bold = false): TableCell {
  return new TableCell({
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        children: [new TextRun({ text, bold })],
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
      left: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
      right: { style: BorderStyle.SINGLE, size: 2, color: "DDDDDD" },
    },
  });
}

function scoreTable(
  baseline: DimensionScores,
  simulated: DimensionScores | null
): Table {
  const header = new TableRow({
    children: simulated
      ? [cell("Dimension", true), cell("Baseline", true), cell("Simulated", true), cell("Δ", true)]
      : [cell("Dimension", true), cell("Baseline", true)],
  });
  const rows = (ALL_DIMENSIONS as ScoreDimension[]).map((dim) => {
    const b = baseline[dim];
    if (!simulated) {
      return new TableRow({ children: [cell(DIMENSION_LABELS[dim]), cell(String(b))] });
    }
    const s = simulated[dim];
    return new TableRow({
      children: [
        cell(DIMENSION_LABELS[dim]),
        cell(String(b)),
        cell(String(s)),
        cell(delta(s - b)),
      ],
    });
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [header, ...rows],
  });
}

/** Minimal markdown → docx paragraphs (headings, bullets, plain paragraphs). */
function markdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = md.split("\n");
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (!text) return;
    out.push(para(plainText(text)));
  };

  for (const line of lines) {
    const h = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(line);
    const b = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      out.push(
        new Paragraph({
          heading:
            level <= 1
              ? HeadingLevel.HEADING_1
              : level === 2
              ? HeadingLevel.HEADING_2
              : HeadingLevel.HEADING_3,
          children: [new TextRun(plainText(h[2]))],
        })
      );
    } else if (b) {
      flush();
      out.push(bullet(plainText(b[1])));
    } else if (!line.trim()) {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/** [text](url) → "text (url)" so links survive into the document visibly. */
function plainText(md: string): string {
  return md.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1 ($2)");
}
