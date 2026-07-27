// ─────────────────────────────────────────────────────────────
//  Shared implementation-packet (.docx) builder.
//
//  The single-page export route (GET /api/optimize/[pageId]/export)
//  and the project-wide bundle route (GET /api/projects/[id]/packets)
//  both render the SAME document from here, so a client's per-page
//  packet is byte-for-byte the same whether pulled one at a time or
//  as part of the "export all" zip.
//
//  Layout contract (2026-07-27):
//   - Every paragraph carries real spacing/leading. Word's default is
//     0pt after / single leading, which made body copy read as one
//     run-on block. Spacing lives in the document default styles so
//     it applies to markdown-derived paragraphs too.
//   - Headings inside "Optimized Content" are TAGGED with the exact
//     tag to use on the page (H1/H2/H3…), and the same outline is
//     repeated as a "Heading Structure" map so the implementer can
//     see the hierarchy at a glance.
//   - A "Schema Markup" section states WHERE the JSON-LD goes and
//     ships a ready-to-paste block built from the draft's own
//     metadata, with [ADD: …] placeholders for anything unknown.
//   - Running footer: "Prism Optimizer, Powered by C3 Technology".
// ─────────────────────────────────────────────────────────────

import { neon } from "@neondatabase/serverless";
import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  BorderStyle,
  Footer,
  PageNumber,
  ShadingType,
} from "docx";
import {
  getDraft,
  getSimulation,
  getPageForOptimize,
  draftMatchesPage,
} from "@/lib/db/drafts";
import { draftToCrawledPage, parseMarkdownHeadings } from "@/lib/optimize/transform";
import { ALL_DIMENSIONS, DIMENSION_LABELS } from "@/lib/types";
import type { DimensionScores, ScoreDimension, PageMetadata } from "@/lib/types";

// Prism Optimizer brand colors (hex, no #) — same palette as the client PDF.
const NAVY = "0B0B24";
const VIOLET = "6F1CFE";
const INK = "1F2430";
const MUTED = "6B6B80";
const RULE = "DDDDE6";
const CODE_BG = "F4F4F9";

export interface BuiltPacket {
  doc: Document;
  /** URL-derived filename slug (no extension). */
  slug: string;
  version: number;
}

/**
 * Build the implementation packet for a saved draft. Derives the page from the
 * draft itself (so it keeps working after a re-audit mints new page rows). If
 * `expectedPageId` is supplied it must match the draft's page, otherwise null
 * is returned — the single-page route uses this to reject mismatched ids.
 */
export async function buildPacket(
  draftId: string,
  simulationId?: string | null,
  expectedPageId?: string
): Promise<BuiltPacket | null> {
  const draft = await getDraft(draftId);
  if (!draft) return null;
  if (expectedPageId && draft.pageId !== expectedPageId) {
    // Re-audits mint NEW page ids while drafts keep their original page row —
    // the hub links current-run page ids to older drafts. Accept the pair when
    // the expected page is the same project + same URL lineage; reject
    // anything else (cross-page/cross-project ids stay 404).
    const expected = await getPageForOptimize(expectedPageId);
    if (!expected || !draftMatchesPage(draft, expected)) return null;
  }

  const [simulation, bundle] = await Promise.all([
    simulationId ? getSimulation(simulationId) : Promise.resolve(null),
    getPageForOptimize(draft.pageId),
  ]);
  if (!bundle) return null;

  const baseline = await loadBaseline(draft.pageId);

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

  const slug =
    bundle.page.url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "page";

  return { doc, slug, version: draft.version };
}

// ── Baseline lookup ───────────────────────────────────────────

export interface BaselineRow {
  scores: DimensionScores;
  overallScore: number;
  grade: string;
  modelVersion: string;
  scoredAt: string;
}

export async function loadBaseline(pageId: string): Promise<BaselineRow | null> {
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
      aioReadiness: (r.score_aio_readiness as number) ?? 0,
      paaCoverage: (r.score_paa_coverage as number) ?? 0,
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
  const outline = parseMarkdownHeadings(draft.bodyMd);

  // ── Header ──────────────────────────────────────────────────
  children.push(
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun("Content Optimization Packet")],
    }),
    para(url, { italics: true, color: MUTED, spaceAfter: 40 }),
    para(
      `Draft v${draft.version} · saved ${draft.createdAt.toISOString().slice(0, 10)}`,
      { color: MUTED, spaceAfter: 240 }
    )
  );

  // ── Projected score impact ──────────────────────────────────
  children.push(sectionHeading("Projected Score Impact"));
  if (baseline && simulation) {
    children.push(
      para(
        `Overall: ${baseline.overallScore} (${baseline.grade}) → ${simulation.overallScore} (${simulation.grade})` +
          `  ·  ${delta(simulation.overallScore - baseline.overallScore)}`,
        { bold: true }
      ),
      scoreTable(baseline.scores, simulation.scores),
      spacer()
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
      children.push(scoreTable(baseline.scores, null), spacer());
    }
  }

  // ── Change summary ──────────────────────────────────────────
  children.push(sectionHeading("Change Summary"));
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
  children.push(spacer());

  // ── Implementation checklist ────────────────────────────────
  children.push(sectionHeading("Implementation Checklist"));
  const checklist = [
    `Replace the page body at ${url} with the "Optimized Content" section below. Every heading there is tagged with the exact HTML tag to use — see "Heading Structure" for the full outline.`,
    `Set the page title to: ${after.title || "(unchanged)"}`,
    `Set the meta description to: ${after.metaDescription || "(unchanged)"}`,
    "Add the JSON-LD block from the \"Schema Markup\" section to the page — inside <head>, or immediately before </body>. Either placement is valid; it must not sit inside the rendered copy.",
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
  children.push(spacer());

  // ── Schema markup ───────────────────────────────────────────
  for (const p of schemaSection(
    url,
    draft.title,
    draft.metaDescription,
    draft.metadata,
    draft.bodyMd
  )) {
    children.push(p);
  }

  // ── Heading structure ───────────────────────────────────────
  children.push(sectionHeading("Heading Structure"));
  if (outline.length === 0) {
    children.push(
      para(
        "The optimized copy has no headings. A page with no H2s is hard for an LLM to segment — add at least two descriptive H2s before publishing.",
        { italics: true }
      ),
      spacer()
    );
  } else {
    children.push(
      para(
        "The exact heading hierarchy to build on the page, in order. Use one H1 only, and never skip a level — an H3 must sit under an H2.",
        { color: MUTED }
      ),
      headingTable(outline),
      spacer()
    );
    const h1Count = outline.filter((h) => h.level === 1).length;
    if (h1Count !== 1) {
      children.push(
        para(
          h1Count === 0
            ? "Note: no H1 appears in the copy below — the page template usually supplies it. Confirm the rendered page has exactly one H1."
            : `Note: ${h1Count} H1s appear in the copy below. A page should have exactly one — demote the extras to H2.`,
          { italics: true, color: MUTED }
        ),
        spacer()
      );
    }
  }

  // ── Final copy ──────────────────────────────────────────────
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      pageBreakBefore: true,
      children: [new TextRun({ text: "Optimized Content", color: NAVY })],
    }),
    para(
      "Each heading below is prefixed with the tag to use — the violet H1 / H2 / H3 label is an instruction, not copy. Do not publish the labels.",
      { color: MUTED, italics: true }
    ),
    spacer()
  );
  for (const p of markdownToParagraphs(draft.bodyMd)) children.push(p);

  return new Document({
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22, color: INK },
          paragraph: { spacing: { after: 180, line: 288, lineRule: "auto" } },
        },
        title: {
          run: { font: "Calibri", size: 40, bold: true, color: NAVY },
          paragraph: { spacing: { after: 120, line: 240, lineRule: "auto" } },
        },
        heading1: {
          run: { font: "Calibri", size: 30, bold: true, color: NAVY },
          paragraph: { spacing: { before: 400, after: 160, line: 264, lineRule: "auto" } },
        },
        heading2: {
          run: { font: "Calibri", size: 26, bold: true, color: NAVY },
          paragraph: { spacing: { before: 320, after: 140, line: 264, lineRule: "auto" } },
        },
        heading3: {
          run: { font: "Calibri", size: 23, bold: true, color: "3B3B5C" },
          paragraph: { spacing: { before: 260, after: 120, line: 264, lineRule: "auto" } },
        },
      },
    },
    sections: [
      {
        properties: {
          page: { margin: { top: 1080, right: 1080, bottom: 1080, left: 1080 } },
        },
        footers: { default: brandFooter() },
        children,
      },
    ],
  });
}

// ── Footer ────────────────────────────────────────────────────

function brandFooter(): Footer {
  return new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: 0, line: 240, lineRule: "auto" },
        border: {
          top: { style: BorderStyle.SINGLE, size: 4, space: 6, color: RULE },
        },
        children: [
          new TextRun({ text: "Prism Optimizer", bold: true, size: 16, color: NAVY }),
          new TextRun({ text: ", Powered by C3 Technology", size: 16, color: MUTED }),
          new TextRun({ text: "   ·   Page ", size: 16, color: MUTED }),
          new TextRun({ children: [PageNumber.CURRENT], size: 16, color: MUTED }),
        ],
      }),
    ],
  });
}

// ── Schema section ────────────────────────────────────────────

const QUESTION_RE =
  /^(who|what|when|where|why|how|is|are|was|were|can|could|do|does|did|should|will|would|which|has|have)\b/i;

function isQuestion(text: string): boolean {
  return text.trim().endsWith("?") || QUESTION_RE.test(text.trim());
}

/** First plain paragraph following a given heading line in the markdown. */
function answerFor(md: string, headingText: string): string {
  const lines = md.split("\n");
  const idx = lines.findIndex((l) => {
    const m = /^\s*#{1,6}\s+(.+?)\s*$/.exec(l);
    return !!m && m[1].replace(/\s+/g, " ").trim() === headingText;
  });
  if (idx === -1) return "";
  const buf: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*#{1,6}\s+/.test(line)) break;
    if (!line.trim()) {
      if (buf.length) break;
      continue;
    }
    buf.push(line.replace(/^\s*[-*]\s+/, "").trim());
  }
  const text = plainText(buf.join(" ")).replace(/\s+/g, " ").trim();
  return text.length > 700 ? `${text.slice(0, 697)}…` : text;
}

function schemaSection(
  url: string,
  title: string,
  metaDescription: string,
  metadata: PageMetadata,
  bodyMd: string
): Paragraph[] {
  const out: Paragraph[] = [];
  const pageUrl = metadata.canonicalUrl || url;
  const type = (metadata.schemaOrgType || "").trim() || "Article";

  out.push(sectionHeading("Schema Markup"));
  out.push(
    para(
      'Where it goes: a single <script type="application/ld+json"> block in the page\'s <head>, or immediately before the closing </body> tag. Both placements are read by Google and by LLM crawlers — use whichever your CMS supports. It must not sit inside the visible copy, and it must not be wrapped in HTML comments.'
    ),
    para(
      `Primary type: ${type}${
        metadata.schemaOrgType
          ? ""
          : " (default — change it if this page is a product, how-to, or FAQ page)"
      }. Values below are pre-filled from this draft. Replace every [ADD: …] placeholder with a real value before publishing, then validate at validator.schema.org and in Google's Rich Results Test.`,
      { color: MUTED }
    ),
    spacer(80)
  );

  const primary: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": type,
    headline: title || "[ADD: page H1 / headline]",
    description: metaDescription || "[ADD: meta description]",
    url: pageUrl,
    mainEntityOfPage: { "@type": "WebPage", "@id": pageUrl },
    author: {
      "@type": "Person",
      name: metadata.author || "[ADD: author name]",
    },
    publisher: {
      "@type": "Organization",
      name: "[ADD: publishing organization name]",
      logo: { "@type": "ImageObject", url: "[ADD: absolute URL to logo image]" },
    },
    datePublished: metadata.publishedDate || "[ADD: YYYY-MM-DD]",
    dateModified:
      metadata.modifiedDate || metadata.publishedDate || "[ADD: YYYY-MM-DD]",
  };
  if (metadata.language) primary.inLanguage = metadata.language;

  out.push(codeLabel(`${type} — paste as-is, then fill the placeholders`));
  for (const line of codeBlockLines(primary)) out.push(line);
  out.push(spacer(80));

  // FAQPage — only when the copy actually contains question headings.
  const questions = parseMarkdownHeadings(bodyMd)
    .filter((h) => h.level >= 2 && isQuestion(h.text))
    .slice(0, 10);

  if (questions.length >= 2) {
    const faq = {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: questions.map((q) => ({
        "@type": "Question",
        name: q.text,
        acceptedAnswer: {
          "@type": "Answer",
          text:
            answerFor(bodyMd, q.text) ||
            "[ADD: answer text — must match the on-page copy word for word]",
        },
      })),
    };
    out.push(
      para(
        `This page carries ${questions.length} question headings, so it also qualifies for FAQPage. Add this as a SECOND JSON-LD block in the same location. Every answer string must match the visible on-page text word for word — Google drops FAQ rich results when they diverge.`
      ),
      codeLabel("FAQPage — second block, same placement"),
      ...codeBlockLines(faq),
      spacer(80)
    );
  } else {
    out.push(
      para(
        "FAQPage schema was not generated: this draft has fewer than two question-form headings. If you add a Q&A section, mark it up as FAQPage and mirror the on-page answers word for word.",
        { italics: true, color: MUTED }
      ),
      spacer(80)
    );
  }

  return out;
}

// ── Helpers ───────────────────────────────────────────────────

interface ParaOpts {
  bold?: boolean;
  italics?: boolean;
  color?: string;
  spaceAfter?: number;
}

function para(text: string, opts: ParaOpts = {}): Paragraph {
  return new Paragraph({
    spacing:
      opts.spaceAfter === undefined
        ? undefined
        : { after: opts.spaceAfter, line: 288, lineRule: "auto" },
    children: [
      new TextRun({ text, bold: opts.bold, italics: opts.italics, color: opts.color }),
    ],
  });
}

function sectionHeading(text: string): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    children: [new TextRun({ text, color: NAVY })],
  });
}

function spacer(after = 160): Paragraph {
  return new Paragraph({ text: "", spacing: { after, line: 240, lineRule: "auto" } });
}

function bullet(text: string): Paragraph {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100, line: 276, lineRule: "auto" },
    children: inlineRuns(text),
  });
}

function codeLabel(text: string): Paragraph {
  return new Paragraph({
    spacing: { before: 120, after: 60, line: 240, lineRule: "auto" },
    children: [
      new TextRun({ text: text.toUpperCase(), bold: true, size: 16, color: VIOLET }),
    ],
  });
}

/** JSON object → one shaded monospace paragraph per line. */
function codeBlockLines(obj: unknown): Paragraph[] {
  const lines = JSON.stringify(obj, null, 2).split("\n");
  return lines.map(
    (line, i) =>
      new Paragraph({
        spacing: {
          before: i === 0 ? 60 : 0,
          after: i === lines.length - 1 ? 60 : 0,
          line: 240,
          lineRule: "auto",
        },
        shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: "auto" },
        children: [
          new TextRun({
            text: line.replace(/\t/g, "  ") || " ",
            font: "Consolas",
            size: 16,
            color: "2C2C3A",
          }),
        ],
      })
  );
}

function delta(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

function cell(text: string, bold = false, fill?: string): TableCell {
  return new TableCell({
    shading: fill ? { type: ShadingType.CLEAR, fill, color: "auto" } : undefined,
    children: [
      new Paragraph({
        alignment: AlignmentType.LEFT,
        spacing: { before: 40, after: 40, line: 240, lineRule: "auto" },
        children: [new TextRun({ text, bold })],
      }),
    ],
    borders: {
      top: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      bottom: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      left: { style: BorderStyle.SINGLE, size: 2, color: RULE },
      right: { style: BorderStyle.SINGLE, size: 2, color: RULE },
    },
  });
}

function scoreTable(
  baseline: DimensionScores,
  simulated: DimensionScores | null
): Table {
  const header = new TableRow({
    children: simulated
      ? [
          cell("Dimension", true, CODE_BG),
          cell("Baseline", true, CODE_BG),
          cell("Simulated", true, CODE_BG),
          cell("Δ", true, CODE_BG),
        ]
      : [cell("Dimension", true, CODE_BG), cell("Baseline", true, CODE_BG)],
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

/** Outline map: tag · indented heading text, in document order. */
function headingTable(outline: { level: number; text: string }[]): Table {
  const header = new TableRow({
    children: [cell("Tag", true, CODE_BG), cell("Heading text", true, CODE_BG)],
  });
  const rows = outline.map(
    (h) =>
      new TableRow({
        children: [
          cell(tagFor(h.level), true),
          cell(`${"    ".repeat(Math.max(0, Math.min(3, h.level - 1)))}${h.text}`),
        ],
      })
  );
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: [1200, 8000],
    rows: [header, ...rows],
  });
}

function tagFor(level: number): string {
  return `H${Math.min(6, Math.max(1, level))}`;
}

/**
 * Minimal markdown → docx paragraphs (headings, bullets, plain paragraphs),
 * with inline bold/italic/code preserved and every heading prefixed by the
 * literal HTML tag the implementer must use.
 */
function markdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = [];
  const lines = md.split("\n");
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    buffer = [];
    if (!text) return;
    out.push(
      new Paragraph({
        spacing: { after: 200, line: 288, lineRule: "auto" },
        children: inlineRuns(text),
      })
    );
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
          children: [
            new TextRun({
              text: `${tagFor(level)}  `,
              bold: true,
              size: 16,
              color: VIOLET,
            }),
            ...inlineRuns(h[2]),
          ],
        })
      );
    } else if (b) {
      flush();
      out.push(bullet(b[1]));
    } else if (!line.trim()) {
      flush();
    } else {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/**
 * Inline markdown → TextRuns. Handles **bold**, *italic* and `code`; markdown
 * links are flattened to "text (url)" first so the destination stays visible.
 * Underscore emphasis is deliberately NOT parsed — underscores are common in
 * URLs and query strings, and mangling those is worse than leaving _ literal.
 */
function inlineRuns(text: string): TextRun[] {
  const flat = plainText(text);
  const parts = flat.split(/(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g).filter(Boolean);
  if (parts.length === 0) return [new TextRun({ text: "" })];
  return parts.map((p) => {
    if (p.startsWith("**") && p.endsWith("**") && p.length > 4) {
      return new TextRun({ text: p.slice(2, -2), bold: true });
    }
    if (p.startsWith("`") && p.endsWith("`") && p.length > 2) {
      return new TextRun({ text: p.slice(1, -1), font: "Consolas", size: 20 });
    }
    if (p.startsWith("*") && p.endsWith("*") && p.length > 2) {
      return new TextRun({ text: p.slice(1, -1), italics: true });
    }
    return new TextRun({ text: p });
  });
}

/** [text](url) → "text (url)" so links survive into the document visibly. */
function plainText(md: string): string {
  return md.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, "$1 ($2)");
}
