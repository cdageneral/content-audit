// ─────────────────────────────────────────────────────────────
//  lib/brand/extract.ts — source ingestion + AI extraction for
//  Brand & Context (server-only).
//
//  Two halves:
//   1. sourceToInput() — turn an uploaded file / fetched URL into
//      model input. DOCX/PPTX are unzipped with jszip (they're
//      zip-of-XML; no new dependency), MD/TXT pass through, URLs
//      go through a plain fetch + cheerio text pass, and PDFs are
//      sent to Claude AS a document block (the API reads PDFs
//      natively — no PDF-parsing dependency).
//   2. extractProfileFromSource() — one forced-tool Claude call
//      that MERGES the source into the existing profile. The
//      model only fills what the source supports; everything is
//      sanitized before it touches the DB, and the human reviews
//      and edits the result on the Brand & Context page.
// ─────────────────────────────────────────────────────────────

import Anthropic from "@anthropic-ai/sdk";
import JSZip from "jszip";
import * as cheerio from "cheerio";
import { recordAnthropicCall } from "@/lib/usage/record";
import {
  sanitizeBrandProfile,
  emptyBrandProfile,
  type BrandProfile,
  type BrandSourceMeta,
} from "./types";

export const BRAND_EXTRACT_MODEL =
  process.env.BRAND_EXTRACT_MODEL ??
  process.env.SCORING_MODEL ??
  "claude-haiku-4-5-20251001";

// Vercel route handlers reject bodies past ~4.5MB; stay safely under it and
// tell the user the real limit instead of letting the platform 413.
export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_CHARS = 120_000;

export type SourceKind = BrandSourceMeta["kind"];

export interface SourceInput {
  kind: SourceKind;
  name: string;
  /** Extracted plain text (all kinds except pdf). */
  text?: string;
  /** Base64 PDF payload (pdf only — Claude reads it natively). */
  pdfBase64?: string;
  detail: string;
}

// ── 1. Source → model input ───────────────────────────────────

export function kindFromFilename(name: string): SourceKind | null {
  const ext = name.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (ext === "docx") return "docx";
  if (ext === "pptx") return "pptx";
  if (ext === "md" || ext === "txt") return "text";
  return null;
}

/** Pull readable text out of OOXML (docx/pptx are zips of XML). */
async function ooxmlToText(buf: ArrayBuffer, kind: "docx" | "pptx"): Promise<string> {
  const zip = await JSZip.loadAsync(buf);
  const paths = Object.keys(zip.files)
    .filter((p) =>
      kind === "docx"
        ? p === "word/document.xml"
        : /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(p)
    )
    .sort();
  const chunks: string[] = [];
  for (const p of paths) {
    const xml = await zip.files[p].async("string");
    // OOXML text lives in <w:t>/<a:t> runs; break paragraphs on </w:p>|</a:p>.
    const text = xml
      .replace(/<\/(w|a):p>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text) chunks.push(text);
  }
  return chunks.join("\n\n");
}

export async function fileToSourceInput(
  name: string,
  buf: ArrayBuffer
): Promise<SourceInput> {
  const kind = kindFromFilename(name);
  if (!kind) {
    throw new Error("Unsupported file type — use PDF, DOCX, PPTX, MD, or TXT");
  }
  if (buf.byteLength > MAX_SOURCE_BYTES) {
    throw new Error("File is too large — the limit is 4 MB per source");
  }
  if (kind === "pdf") {
    return {
      kind,
      name,
      pdfBase64: Buffer.from(buf).toString("base64"),
      detail: `${(buf.byteLength / 1024).toFixed(0)} KB PDF`,
    };
  }
  let text: string;
  if (kind === "docx" || kind === "pptx") {
    text = await ooxmlToText(buf, kind);
  } else {
    text = Buffer.from(buf).toString("utf-8");
  }
  text = text.slice(0, MAX_TEXT_CHARS);
  if (!text.trim()) {
    throw new Error("Couldn't find any readable text in that file");
  }
  return {
    kind,
    name,
    text,
    detail: `${text.length.toLocaleString()} chars`,
  };
}

export async function urlToSourceInput(url: string): Promise<SourceInput> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("That doesn't look like a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http(s) URLs are supported");
  }
  const res = await fetch(parsed.toString(), {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}`);
  const html = await res.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, nav, footer, iframe").remove();
  const text = $("body").text().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
  if (text.length < 100) {
    throw new Error("Couldn't extract meaningful text from that page");
  }
  return {
    kind: "url",
    name: parsed.hostname + parsed.pathname.replace(/\/$/, ""),
    text,
    detail: `${text.length.toLocaleString()} chars fetched`,
  };
}

// ── 2. AI extraction (merge source → profile) ─────────────────

const EXTRACT_TOOL = {
  name: "save_brand_profile",
  description:
    "Save the updated brand profile extracted from the source document, merged with the existing profile.",
  input_schema: {
    type: "object" as const,
    properties: {
      voice: {
        type: "object",
        properties: {
          descriptors: { type: "array", items: { type: "string" }, description: "Short tone descriptors, e.g. 'Confident, not boastful'" },
          pointOfView: { type: "string", description: "Person/POV rules, e.g. second person for readers, 'we' for the company" },
          sliders: {
            type: "object",
            properties: {
              formalCasual: { type: "number", description: "0 = very formal, 100 = very conversational" },
              reservedBold: { type: "number", description: "0 = reserved, 100 = bold" },
              technicalPlain: { type: "number", description: "0 = technical, 100 = plain-spoken" },
            },
            required: ["formalCasual", "reservedBold", "technicalPlain"],
          },
          sourceNote: { type: "string" },
        },
        required: ["descriptors", "pointOfView", "sliders", "sourceNote"],
      },
      audience: {
        type: "object",
        properties: {
          personas: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                role: { type: "string", enum: ["primary", "secondary"] },
                description: { type: "string", description: "Who they are and how to write for them, 1-3 sentences" },
              },
              required: ["name", "role", "description"],
            },
          },
          sourceNote: { type: "string" },
        },
        required: ["personas", "sourceNote"],
      },
      facts: {
        type: "object",
        properties: {
          boilerplate: { type: "string", description: "Standard company description paragraph" },
          products: { type: "array", items: { type: "string" } },
          proofPoints: {
            type: "array",
            items: { type: "string" },
            description: "ONLY stats/claims stated verbatim in the source (e.g. '400+ customers'). Never infer or round.",
          },
          sourceNote: { type: "string" },
        },
        required: ["boilerplate", "products", "proofPoints", "sourceNote"],
      },
      style: {
        type: "object",
        properties: {
          preferredTerms: { type: "array", items: { type: "string" } },
          bannedTerms: { type: "array", items: { type: "string" }, description: "Words the source says to avoid" },
          styleRules: { type: "string", description: "Other writing rules as prose (oxford comma, number style, etc.)" },
          complianceNotes: { type: "string", description: "Legal/compliance constraints on claims" },
          headingCase: { type: ["string", "null"], enum: ["sentence", "title", null], description: "Only if the source states a heading-case rule" },
          noExclamations: { type: "boolean", description: "TRUE only if the source forbids exclamation points" },
          maxReadingGrade: { type: ["number", "null"], description: "Only if the source states a reading-level target" },
          sourceNote: { type: "string" },
        },
        required: ["preferredTerms", "bannedTerms", "styleRules", "complianceNotes", "headingCase", "noExclamations", "maxReadingGrade", "sourceNote"],
      },
    },
    required: ["voice", "audience", "facts", "style"],
  },
};

const EXTRACT_SYSTEM = `You extract brand and company information from a client document into a structured brand profile that will steer AI-written content for that client.

Hard rules:
1. Extract ONLY what the source actually says. Never invent, infer beyond the text, or fill gaps with typical values. If the source says nothing about a field, keep the existing profile's value for it (or leave it empty).
2. Proof points must be VERBATIM claims from the source ("400+ customers since 2014"). Never round, combine, or extrapolate figures.
3. You are MERGING into an existing profile: keep existing entries unless the source contradicts them, and add what's new. Deduplicate.
4. sourceNote fields: set to the given source name for sections this source informed; keep the existing note otherwise (append " + <source>" if both contributed).
5. Sliders are your reading of the source's stated tone guidance (0-100); if the source gives no tone guidance, keep the existing values.
6. headingCase / noExclamations / maxReadingGrade: set ONLY when the source states such a rule explicitly; otherwise keep existing values.`;

export async function extractProfileFromSource(
  projectId: string,
  source: SourceInput,
  existing: BrandProfile | null
): Promise<BrandProfile> {
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 95_000,
    maxRetries: 1,
  });

  const current = existing ?? emptyBrandProfile();
  const intro =
    `Source name: ${source.name}\n\n` +
    `## Existing brand profile (merge into this — keep values the source doesn't change)\n\n` +
    `${JSON.stringify({ ...current, enabled: undefined })}\n\n` +
    `## Source document\n\n`;

  // PDFs go to the API as a native document block; everything else as text.
  // (Document blocks postdate this SDK version's types — shape per current
  // API docs, cast through the SDK's looser content type.)
  const content =
    source.kind === "pdf" && source.pdfBase64
      ? ([
          { type: "text", text: intro },
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: source.pdfBase64,
            },
          },
        ] as unknown as Anthropic.MessageParam["content"])
      : intro + (source.text ?? "");

  const response = await anthropic.messages.create({
    model: BRAND_EXTRACT_MODEL,
    max_tokens: 4096,
    temperature: 0,
    system: EXTRACT_SYSTEM,
    tools: [EXTRACT_TOOL as Anthropic.Tool],
    tool_choice: { type: "any" },
    messages: [{ role: "user", content }],
  });

  await recordAnthropicCall({
    purpose: "brand_extract",
    model: BRAND_EXTRACT_MODEL,
    usage: response.usage,
    projectId,
    meta: { source: source.name, kind: source.kind },
  });

  const toolUse = response.content.find((b) => b.type === "tool_use");
  if (!toolUse || toolUse.type !== "tool_use") {
    throw new Error("Extraction failed — the model returned no structured profile");
  }

  const merged = sanitizeBrandProfile(toolUse.input);
  // enabled flags are the human's choice, never the model's — carry them over.
  merged.enabled = current.enabled;
  return merged;
}
