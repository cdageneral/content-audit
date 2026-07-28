// ─────────────────────────────────────────────────────────────
//  lib/brand/lint.ts — the DETERMINISTIC brand check.
//
//  ⚠️ CLIENT-SAFE MODULE (runs in the workbench browser bundle):
//  pure string functions only — no DB, no model calls, no
//  server imports. Every check here is a real, reproducible
//  string measurement; there is deliberately NO "tone match"
//  check because tone cannot be verified deterministically and
//  a modeled verdict would violate the project's data-honesty
//  rule. If a tone check is ever added it must be a separate,
//  clearly-labeled model pass.
// ─────────────────────────────────────────────────────────────

import type { BrandProfile } from "./types";

export interface BrandLintFinding {
  id: string;
  status: "pass" | "warn";
  label: string;
  /** Only set on warns — what specifically tripped. */
  detail?: string;
}

export interface BrandLintResult {
  findings: BrandLintFinding[];
  warnCount: number;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Strip markdown syntax down to prose for text-level checks. */
export function markdownToProse(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // code blocks
    .replace(/`[^`]*`/g, " ") // inline code
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links → text
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/[*_>#|-]/g, " ") // remaining markup
    .replace(/\s+/g, " ")
    .trim();
}

export function extractHeadings(md: string): string[] {
  const out: string[] = [];
  for (const line of md.split("\n")) {
    const m = /^#{1,6}\s+(.+)$/.exec(line.trim());
    if (m) out.push(m[1].trim());
  }
  return out;
}

// ── Individual checks ─────────────────────────────────────────

export function findBannedTerms(
  text: string,
  bannedTerms: string[]
): { term: string; count: number }[] {
  const hits: { term: string; count: number }[] = [];
  for (const term of bannedTerms) {
    const t = term.trim();
    if (!t) continue;
    const re = new RegExp(`\\b${esc(t)}\\b`, "gi");
    const count = (text.match(re) ?? []).length;
    if (count > 0) hits.push({ term: t, count });
  }
  return hits;
}

/**
 * Heuristic case classifier for one heading. "Looks title-case" = two or
 * more non-leading longish words capitalized (all-caps acronyms don't count).
 * Deliberately loose — proper nouns make an exact check impossible, so the
 * lint labels findings as "looks like", never as certainties.
 */
function looksTitleCase(heading: string): boolean {
  const words = heading.split(/\s+/).slice(1); // ignore the first word
  let capped = 0;
  for (const w of words) {
    const clean = w.replace(/[^A-Za-z']/g, "");
    if (clean.length < 4) continue; // short words are cased either way in title case
    if (clean === clean.toUpperCase()) continue; // acronym
    if (/^[A-Z]/.test(clean)) capped++;
  }
  return capped >= 2;
}

/** Flesch–Kincaid grade level — the standard published formula, unrounded inputs. */
export function fleschKincaidGrade(prose: string): number | null {
  const sentences = prose.split(/[.!?]+\s/).filter((s) => s.trim().length > 0);
  const words = prose.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (sentences.length === 0 || words.length < 30) return null; // too little text to measure
  let syllables = 0;
  for (const w of words) syllables += countSyllables(w);
  const grade =
    0.39 * (words.length / sentences.length) +
    11.8 * (syllables / words.length) -
    15.59;
  return Math.round(grade * 10) / 10;
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "");
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

// ── The full lint ─────────────────────────────────────────────

export function runBrandLint(
  profile: BrandProfile,
  title: string,
  bodyMd: string
): BrandLintResult {
  const findings: BrandLintFinding[] = [];
  const prose = markdownToProse(bodyMd);
  const fullText = `${title}\n${prose}`;
  const style = profile.style;
  const styleOn = profile.enabled.style;

  // 1. Banned terms (only meaningful when the style section is on).
  if (styleOn && style.bannedTerms.length) {
    const hits = findBannedTerms(fullText, style.bannedTerms);
    findings.push(
      hits.length === 0
        ? { id: "banned", status: "pass", label: "No banned terms used" }
        : {
            id: "banned",
            status: "warn",
            label: `Banned term${hits.length > 1 ? "s" : ""} found`,
            detail: hits.map((h) => `"${h.term}" ×${h.count}`).join(", "),
          }
    );
  }

  // 2. Heading case.
  if (styleOn && style.headingCase) {
    const headings = extractHeadings(bodyMd);
    if (headings.length) {
      const offenders = headings.filter((h) =>
        style.headingCase === "sentence" ? looksTitleCase(h) : !looksTitleCase(h)
      );
      findings.push(
        offenders.length === 0
          ? {
              id: "headingCase",
              status: "pass",
              label: `Headings look ${style.headingCase}-case`,
            }
          : {
              id: "headingCase",
              status: "warn",
              label: `${offenders.length} heading${offenders.length > 1 ? "s" : ""} may not be ${style.headingCase} case`,
              detail: offenders.slice(0, 3).map((h) => `"${h}"`).join(" · "),
            }
      );
    }
  }

  // 3. Exclamation points.
  if (styleOn && style.noExclamations) {
    const count = (prose.match(/!/g) ?? []).length;
    findings.push(
      count === 0
        ? { id: "exclaim", status: "pass", label: "No exclamation points" }
        : {
            id: "exclaim",
            status: "warn",
            label: `${count} exclamation point${count > 1 ? "s" : ""} (profile says none)`,
          }
    );
  }

  // 4. Reading grade (Flesch–Kincaid — a real formula, not a model's opinion).
  if (styleOn && style.maxReadingGrade !== null) {
    const grade = fleschKincaidGrade(prose);
    if (grade !== null) {
      findings.push(
        grade <= style.maxReadingGrade
          ? {
              id: "grade",
              status: "pass",
              label: `Reading level grade ${grade} (limit ${style.maxReadingGrade})`,
            }
          : {
              id: "grade",
              status: "warn",
              label: `Reading level grade ${grade} — profile limit is ${style.maxReadingGrade}`,
              detail: "Flesch–Kincaid on the body copy",
            }
      );
    }
  }

  // 5. Proof-point discipline is enforced at generation time (whitelist in the
  //    prompt) and by the routes' no-invented-facts rule; there is no reliable
  //    deterministic way to detect an unapproved stat, so no check is shown —
  //    an unverifiable green tick would be worse than none.

  return {
    findings,
    warnCount: findings.filter((f) => f.status === "warn").length,
  };
}
