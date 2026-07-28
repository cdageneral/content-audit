// ─────────────────────────────────────────────────────────────
//  lib/brand/types.ts — the Brand & Context profile shape.
//
//  ⚠️ CLIENT-SAFE MODULE: imported by client components
//  (BrandContextView, BrandCheck). No DB driver, no server-only
//  imports may ever be added here — that would drag Neon into
//  the client bundle (same rule as lib/hub.ts, inverted).
//
//  Design intent: the profile is the APPROVED, human-edited
//  contract for what the AI is told about this client's brand.
//  Free-text fields carry nuance for the model; the structured
//  fields (bannedTerms, headingCase, noExclamations,
//  maxReadingGrade) exist so the brand check can be a
//  DETERMINISTIC linter — real string checks, never a modeled
//  verdict (Wayne's data-honesty rule).
// ─────────────────────────────────────────────────────────────

export interface BrandVoice {
  /** Short tone descriptors, e.g. "Confident, not boastful". */
  descriptors: string[];
  /** e.g. `Second person ("you") for readers; "we" for the company.` */
  pointOfView: string;
  /** 0 = left label, 100 = right label. Presentation + prompt hints only. */
  sliders: {
    formalCasual: number; // formal ←→ conversational
    reservedBold: number; // reserved ←→ bold
    technicalPlain: number; // technical ←→ plain-spoken
  };
  /** Where this section came from, e.g. "Brand-Guidelines-2026.pdf". */
  sourceNote: string;
}

export interface BrandPersona {
  name: string;
  role: "primary" | "secondary";
  description: string;
}

export interface BrandAudience {
  personas: BrandPersona[];
  sourceNote: string;
}

export interface BrandFacts {
  /** Standard company boilerplate paragraph. */
  boilerplate: string;
  /** Product / service names the AI may reference. */
  products: string[];
  /**
   * The ONLY factual claims/stats the AI may cite. This is a whitelist —
   * generation prompts state explicitly that no other figures may be used.
   */
  proofPoints: string[];
  sourceNote: string;
}

export interface BrandStyle {
  preferredTerms: string[];
  /** Words/phrases the AI must never use (deterministically lintable). */
  bannedTerms: string[];
  /** Free-text style rules passed to the model verbatim. */
  styleRules: string;
  /** Legal/compliance constraints passed to the model verbatim. */
  complianceNotes: string;
  /** Structured, lintable subset of the style rules: */
  headingCase: "sentence" | "title" | null;
  noExclamations: boolean;
  /** Max Flesch–Kincaid grade level for body copy, or null = unchecked. */
  maxReadingGrade: number | null;
  sourceNote: string;
}

export type BrandSectionKey = "voice" | "audience" | "facts" | "style";

export const BRAND_SECTIONS: BrandSectionKey[] = [
  "voice",
  "audience",
  "facts",
  "style",
];

export const BRAND_SECTION_LABELS: Record<BrandSectionKey, string> = {
  voice: "Voice & tone",
  audience: "Audience",
  facts: "Company facts",
  style: "Terminology & style",
};

export interface BrandProfile {
  voice: BrandVoice;
  audience: BrandAudience;
  facts: BrandFacts;
  style: BrandStyle;
  /** Per-section master switches — an OFF section is never injected. */
  enabled: Record<BrandSectionKey, boolean>;
}

export interface BrandSourceMeta {
  id: string;
  kind: "pdf" | "docx" | "pptx" | "text" | "url";
  name: string;
  /** Human meta line, e.g. "12,400 chars · extracted Jul 28". */
  detail: string;
  status: "done" | "error";
  error: string | null;
  createdAt: string; // ISO
}

/** A serializable summary for chips/badges ("Brand context: ON · 3 of 4"). */
export interface BrandContextSummary {
  active: boolean;
  sectionsOn: number;
  sectionsTotal: number;
}

// ── Constructors / sanitizers (shared by API + UI) ────────────

export function emptyBrandProfile(): BrandProfile {
  return {
    voice: {
      descriptors: [],
      pointOfView: "",
      sliders: { formalCasual: 50, reservedBold: 50, technicalPlain: 50 },
      sourceNote: "",
    },
    audience: { personas: [], sourceNote: "" },
    facts: { boilerplate: "", products: [], proofPoints: [], sourceNote: "" },
    style: {
      preferredTerms: [],
      bannedTerms: [],
      styleRules: "",
      complianceNotes: "",
      headingCase: null,
      noExclamations: false,
      maxReadingGrade: null,
      sourceNote: "",
    },
    enabled: { voice: true, audience: true, facts: true, style: true },
  };
}

const str = (v: unknown, max = 4000): string =>
  typeof v === "string" ? v.slice(0, max) : "";

const strList = (v: unknown, maxItems = 40, maxLen = 200): string[] =>
  Array.isArray(v)
    ? v
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => x.trim().slice(0, maxLen))
        .slice(0, maxItems)
    : [];

const num01 = (v: unknown, fallback = 50): number =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : fallback;

/**
 * Coerce untrusted JSON (model output OR client PUT body) into a valid
 * BrandProfile. Anything malformed collapses to a safe empty value — the
 * profile can never carry executable/oversized junk into prompts.
 */
export function sanitizeBrandProfile(input: unknown): BrandProfile {
  const p = (input ?? {}) as Record<string, any>;
  const base = emptyBrandProfile();

  const v = p.voice ?? {};
  base.voice = {
    descriptors: strList(v.descriptors, 12),
    pointOfView: str(v.pointOfView, 500),
    sliders: {
      formalCasual: num01(v?.sliders?.formalCasual),
      reservedBold: num01(v?.sliders?.reservedBold),
      technicalPlain: num01(v?.sliders?.technicalPlain),
    },
    sourceNote: str(v.sourceNote, 200),
  };

  const a = p.audience ?? {};
  base.audience = {
    personas: Array.isArray(a.personas)
      ? a.personas
          .filter((x: unknown) => x && typeof x === "object")
          .map((x: Record<string, unknown>) => ({
            name: str(x.name, 120),
            role: x.role === "secondary" ? ("secondary" as const) : ("primary" as const),
            description: str(x.description, 600),
          }))
          .filter((x: BrandPersona) => x.name || x.description)
          .slice(0, 6)
      : [],
    sourceNote: str(a.sourceNote, 200),
  };

  const f = p.facts ?? {};
  base.facts = {
    boilerplate: str(f.boilerplate, 1200),
    products: strList(f.products, 20),
    proofPoints: strList(f.proofPoints, 20, 300),
    sourceNote: str(f.sourceNote, 200),
  };

  const s = p.style ?? {};
  base.style = {
    preferredTerms: strList(s.preferredTerms, 40),
    bannedTerms: strList(s.bannedTerms, 40),
    styleRules: str(s.styleRules, 1200),
    complianceNotes: str(s.complianceNotes, 1200),
    headingCase:
      s.headingCase === "sentence" || s.headingCase === "title"
        ? s.headingCase
        : null,
    noExclamations: s.noExclamations === true,
    maxReadingGrade:
      typeof s.maxReadingGrade === "number" &&
      Number.isFinite(s.maxReadingGrade) &&
      s.maxReadingGrade >= 3 &&
      s.maxReadingGrade <= 18
        ? Math.round(s.maxReadingGrade)
        : null,
    sourceNote: str(s.sourceNote, 200),
  };

  const e = p.enabled ?? {};
  base.enabled = {
    voice: e.voice !== false,
    audience: e.audience !== false,
    facts: e.facts !== false,
    style: e.style !== false,
  };

  return base;
}

/** TRUE when a section actually carries content worth injecting. */
export function sectionHasContent(
  profile: BrandProfile,
  key: BrandSectionKey
): boolean {
  switch (key) {
    case "voice":
      return (
        profile.voice.descriptors.length > 0 ||
        profile.voice.pointOfView.trim().length > 0
      );
    case "audience":
      return profile.audience.personas.length > 0;
    case "facts":
      return (
        profile.facts.boilerplate.trim().length > 0 ||
        profile.facts.products.length > 0 ||
        profile.facts.proofPoints.length > 0
      );
    case "style":
      return (
        profile.style.preferredTerms.length > 0 ||
        profile.style.bannedTerms.length > 0 ||
        profile.style.styleRules.trim().length > 0 ||
        profile.style.complianceNotes.trim().length > 0 ||
        profile.style.headingCase !== null ||
        profile.style.noExclamations ||
        profile.style.maxReadingGrade !== null
      );
  }
}

export function summarizeBrandContext(
  profile: BrandProfile | null
): BrandContextSummary {
  if (!profile) {
    return { active: false, sectionsOn: 0, sectionsTotal: BRAND_SECTIONS.length };
  }
  const on = BRAND_SECTIONS.filter(
    (k) => profile.enabled[k] && sectionHasContent(profile, k)
  ).length;
  return { active: on > 0, sectionsOn: on, sectionsTotal: BRAND_SECTIONS.length };
}
