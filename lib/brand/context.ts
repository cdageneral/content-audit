// ─────────────────────────────────────────────────────────────
//  lib/brand/context.ts — turns a project's approved brand
//  profile into the prompt block injected into every AI writing
//  call (rewrite, generate). Server-only (reads the store).
//
//  Rules encoded here:
//   • Only sections that are BOTH enabled AND non-empty inject.
//   • Proof points are a WHITELIST: the block explicitly forbids
//     any company stat not listed (belt on top of the routes'
//     existing "never invent facts" rule 1 — the profile can only
//     tighten claims, never license new ones).
//   • Slider values render as words, not numbers — "leans
//     conversational" prompts better than "68/100".
// ─────────────────────────────────────────────────────────────

import { getBrandProfile } from "./store";
import {
  sectionHasContent,
  summarizeBrandContext,
  type BrandContextSummary,
  type BrandProfile,
} from "./types";

export interface BrandContextResult extends BrandContextSummary {
  /** Ready-to-append prompt block ("" when inactive). */
  block: string;
}

const EMPTY: BrandContextResult = {
  block: "",
  active: false,
  sectionsOn: 0,
  sectionsTotal: 4,
};

export async function buildBrandContext(
  projectId: string | null | undefined
): Promise<BrandContextResult> {
  if (!projectId) return EMPTY;
  const stored = await getBrandProfile(projectId).catch(() => null);
  if (!stored) return EMPTY;
  const summary = summarizeBrandContext(stored.profile);
  if (!summary.active) return { ...EMPTY, sectionsTotal: summary.sectionsTotal };
  return { ...summary, block: renderBrandBlock(stored.profile) };
}

// ── Rendering ─────────────────────────────────────────────────

function lean(value: number, left: string, right: string): string {
  if (value <= 33) return `leans ${left}`;
  if (value >= 67) return `leans ${right}`;
  return `balanced between ${left} and ${right}`;
}

export function renderBrandBlock(p: BrandProfile): string {
  const parts: string[] = [];

  if (p.enabled.voice && sectionHasContent(p, "voice")) {
    const v = p.voice;
    const lines = ["### Voice & tone"];
    if (v.descriptors.length)
      lines.push(`Tone: ${v.descriptors.join("; ")}.`);
    lines.push(
      `Register: ${lean(v.sliders.formalCasual, "formal", "conversational")}; ` +
        `${lean(v.sliders.reservedBold, "reserved", "bold")}; ` +
        `${lean(v.sliders.technicalPlain, "technical", "plain-spoken")}.`
    );
    if (v.pointOfView.trim()) lines.push(`Point of view: ${v.pointOfView.trim()}`);
    parts.push(lines.join("\n"));
  }

  if (p.enabled.audience && sectionHasContent(p, "audience")) {
    const lines = ["### Audience (write for these readers)"];
    for (const per of p.audience.personas) {
      lines.push(
        `- ${per.name}${per.role === "primary" ? " (primary)" : " (secondary)"}: ${per.description}`
      );
    }
    parts.push(lines.join("\n"));
  }

  if (p.enabled.facts && sectionHasContent(p, "facts")) {
    const f = p.facts;
    const lines = ["### Company facts"];
    if (f.boilerplate.trim()) lines.push(`Boilerplate: ${f.boilerplate.trim()}`);
    if (f.products.length)
      lines.push(`Products/services you may reference: ${f.products.join(", ")}.`);
    if (f.proofPoints.length) {
      lines.push(
        "Approved proof points — these are the ONLY company statistics/claims you may cite; do not use any company figure not on this list:"
      );
      for (const pp of f.proofPoints) lines.push(`- ${pp}`);
    }
    parts.push(lines.join("\n"));
  }

  if (p.enabled.style && sectionHasContent(p, "style")) {
    const s = p.style;
    const lines = ["### Terminology & style"];
    if (s.preferredTerms.length)
      lines.push(`Preferred terms: ${s.preferredTerms.join(", ")}.`);
    if (s.bannedTerms.length)
      lines.push(`NEVER use these words/phrases: ${s.bannedTerms.join(", ")}.`);
    const structured: string[] = [];
    if (s.headingCase === "sentence") structured.push("sentence-case headings");
    if (s.headingCase === "title") structured.push("title-case headings");
    if (s.noExclamations) structured.push("no exclamation points");
    if (s.maxReadingGrade !== null)
      structured.push(`keep body copy at or below a grade-${s.maxReadingGrade} reading level`);
    if (structured.length) lines.push(`Formatting rules: ${structured.join("; ")}.`);
    if (s.styleRules.trim()) lines.push(`Style rules: ${s.styleRules.trim()}`);
    if (s.complianceNotes.trim())
      lines.push(`Compliance constraints (hard limits): ${s.complianceNotes.trim()}`);
    parts.push(lines.join("\n"));
  }

  if (!parts.length) return "";

  return `## Brand & company context (client-approved profile — follow it strictly)

Write in this client's brand voice. Where these rules conflict with matching the page's existing register, the brand profile wins.

${parts.join("\n\n")}
`;
}
