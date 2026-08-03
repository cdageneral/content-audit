// ─────────────────────────────────────────────────────────────
//  Business Impact model — pure math, importable from client
//  components (NO server/db imports allowed in this file).
//
//  The page translates visibility into business terms across two
//  lanes, and every figure carries a provenance class the UI must
//  render as a tag:
//
//    verified  — measured in this project's own scans (demand
//                volumes, prompt-citation coverage). Never modeled.
//    modeled   — a published curve or a stated modeling assumption
//                (CTR by position; the coverage→visits scaling).
//    benchmark — a published industry figure the client can
//                override (conversion rate, AI visitor premium).
//    client    — a number only the client can supply (value per
//                lead, GA4 AI referral visits). No public benchmark
//                exists for these; we never invent one.
//
//  Null beats zero everywhere: a missing input renders "—", never
//  an invented figure. That rule is what lets the dollar outputs
//  survive a CFO in the room.
// ─────────────────────────────────────────────────────────────

import { ctrFor, aioFactor } from "@/lib/rankings/ctr";

// ── Published sources (rendered verbatim in the UI footnote) ──

export const CONV_SOURCE =
  "Ruler Analytics conversion benchmarks, May 2026 — 110M+ sessions, 5M+ conversions, organic-search column";
export const CONV_SOURCE_URL =
  "https://www.ruleranalytics.com/blog/insight/conversion-rate-by-industry/";

export const AI_VALUE_SOURCE = "Semrush AI search traffic study, June 2025";
export const AI_VALUE_SOURCE_URL =
  "https://www.semrush.com/blog/ai-search-seo-traffic-study/";

/** Default LLM-visitor value premium vs an organic visitor (Semrush, above). */
export const AI_PREMIUM_DEFAULT = 4.4;

// ── Industry benchmarks (Ruler Analytics, organic-search column) ──

export interface IndustryBenchmark {
  key: string;
  label: string;
  /** Organic-search visit → lead conversion rate, percent. */
  organicConvRate: number;
}

export const INDUSTRY_BENCHMARKS: IndustryBenchmark[] = [
  { key: "professional_services", label: "Professional services", organicConvRate: 8.1 },
  { key: "software", label: "Software", organicConvRate: 7.9 },
  { key: "education", label: "Education", organicConvRate: 7.4 },
  { key: "legal", label: "Legal", organicConvRate: 7.3 },
  { key: "marketing_advertising", label: "Marketing & advertising", organicConvRate: 5.8 },
  { key: "automotive", label: "Automotive", organicConvRate: 5.7 },
  { key: "finance", label: "Finance", organicConvRate: 5.4 },
  { key: "construction_engineering", label: "Construction & engineering", organicConvRate: 4.8 },
  { key: "beauty_cosmetic", label: "Beauty & cosmetic", organicConvRate: 3.2 },
  { key: "real_estate", label: "Real estate", organicConvRate: 2.4 },
  { key: "retail_ecommerce", label: "Retail & ecommerce", organicConvRate: 2.0 },
  { key: "health_social_care", label: "Health & social care", organicConvRate: 1.8 },
  { key: "travel", label: "Travel", organicConvRate: 1.8 },
];

export function industryByKey(key: string | null): IndustryBenchmark | null {
  if (!key) return null;
  return INDUSTRY_BENCHMARKS.find((i) => i.key === key) ?? null;
}

// ── Inputs (persisted per project; benchmark defaults, overridable) ──

export interface ImpactInputs {
  /** Industry benchmark key, or null when not chosen yet. */
  industry: string | null;
  /** Visit → lead rate, percent. Benchmark default; client-overridable. */
  convRate: number | null;
  /** USD per lead. Client input ONLY — no credible public benchmark. */
  leadValue: number | null;
  /** Current monthly AI-assistant referral visits (client's GA4). */
  aiVisits: number | null;
  /** LLM-visitor value premium vs organic (Semrush 4.4× default). */
  aiPremium: number;
  /** Apply the Seer AIO click discount to the Google lane (off by default). */
  aioDiscount: boolean;
}

export const DEFAULT_INPUTS: ImpactInputs = {
  industry: null,
  convRate: null,
  leadValue: null,
  aiVisits: null,
  aiPremium: AI_PREMIUM_DEFAULT,
  aioDiscount: false,
};

// ── Baselines (assembled server-side from this project's scans) ──

export interface GoogleBaseline {
  /** TRUE when ≥1 keyword in the latest scan carries a verified volume. */
  volumesOk: boolean;
  /** Verified monthly searches on keywords ranked 11–20 (striking distance). */
  strikingVol: number;
  /** …of that, searches whose SERP carries an AI Overview or PAA box. */
  strikingVolOnAio: number;
  /** Distinct non-branded keywords behind strikingVol. */
  strikingKeywords: number;
  /** Total verified monthly searches across tracked keywords. */
  totalDemand: number;
  /** …of that, demand on keywords ranked in the top 10. */
  top10Demand: number;
  /** Keywords with a verified volume / non-branded keywords tracked. */
  covered: number;
  tracked: number;
  /** ISO timestamp of the scan these figures come from. */
  fetchedAt: string;
}

export interface AiBaseline {
  /** Active buyer-intent prompts in the project's prompt set. */
  promptsTotal: number;
  /** Prompts with ≥1 successful engine check on record. */
  promptsChecked: number;
  /** Prompts whose latest checks include ≥1 citation of the client. */
  promptsCited: number;
  /** Engines that have produced at least one successful check. */
  engines: string[];
  /** TRUE when any successful engine check exists — the lane is measured. */
  measured: boolean;
}

// ── Scenarios ─────────────────────────────────────────────────

export interface ScenarioDef {
  key: "conservative" | "expected" | "ambitious";
  label: string;
  /** Google lane: target average position for striking-distance keywords. */
  gPos: number;
  /** AI lane: target share of the prompt set citing the client. */
  coveragePct: number;
  featured: boolean;
}

export const SCENARIOS: ScenarioDef[] = [
  { key: "conservative", label: "Conservative", gPos: 8, coveragePct: 0.1, featured: false },
  { key: "expected", label: "Expected", gPos: 5, coveragePct: 0.25, featured: true },
  { key: "ambitious", label: "Ambitious", gPos: 3, coveragePct: 0.5, featured: false },
];

export interface GoogleLaneResult {
  ctr: number;
  /** Modeled monthly visits at the target position, or null when unmeasured. */
  visits: number | null;
  /** Modeled monthly leads (needs a conversion rate). */
  leads: number | null;
  /** Modeled annual pipeline (needs a value per lead). */
  annual: number | null;
}

export interface AiLaneResult {
  /** Target count of prompts citing the client (≥ the measured baseline). */
  targetCited: number | null;
  /** Implied AI-visit multiple vs today — the stated modeling assumption. */
  multiple: number | null;
  /** TRUE when the baseline coverage was 0 and floored at 1 prompt. */
  flooredBaseline: boolean;
  /** Modeled monthly AI visits (needs the client's GA4 baseline). */
  visits: number | null;
  /** Effective visit → lead rate after the value premium, percent. */
  leadRate: number | null;
  leads: number | null;
  annual: number | null;
}

export interface ScenarioResult {
  def: ScenarioDef;
  google: GoogleLaneResult;
  ai: AiLaneResult;
  /** Sum of the lanes' annual figures; null when NEITHER lane has one. */
  totalAnnual: number | null;
}

/**
 * Compute one scenario. Pure; safe to run client-side on every input change.
 *
 * Google lane: striking-distance demand × published CTR at the target
 * position (per-keyword AIO exposure honoured when the discount is on —
 * the uncited factor, since a page arriving on page 1 is not presumed to
 * win the AI answer too).
 *
 * AI lane: the client's own measured AI referral visits, scaled linearly
 * with prompt-citation coverage. THAT LINK IS A MODELING ASSUMPTION with
 * no published measurement behind it — the UI must state it and print the
 * implied multiple. When measured coverage is zero, the baseline floors
 * at one prompt (flagged via flooredBaseline) because linear scaling from
 * zero is undefined.
 */
export function computeScenario(
  def: ScenarioDef,
  g: GoogleBaseline | null,
  a: AiBaseline,
  inp: ImpactInputs
): ScenarioResult {
  const ctr = ctrFor(def.gPos) ?? 0;
  const conv = inp.convRate;

  // ── Google lane ──
  let gVisits: number | null = null;
  if (g && g.volumesOk && g.strikingVol > 0) {
    const plainVol = g.strikingVol - g.strikingVolOnAio;
    gVisits = inp.aioDiscount
      ? Math.round(plainVol * ctr + g.strikingVolOnAio * ctr * aioFactor(true, false))
      : Math.round(g.strikingVol * ctr);
  }
  const gLeads = gVisits !== null && conv !== null ? (gVisits * conv) / 100 : null;
  const gAnnual =
    gLeads !== null && inp.leadValue !== null ? Math.round(gLeads * inp.leadValue * 12) : null;

  // ── AI lane ──
  let targetCited: number | null = null;
  let multiple: number | null = null;
  let flooredBaseline = false;
  let aiVisits: number | null = null;
  let aiLeadRate: number | null = null;
  let aiLeads: number | null = null;
  let aiAnnual: number | null = null;

  if (a.measured && a.promptsTotal > 0) {
    targetCited = Math.max(Math.ceil(a.promptsTotal * def.coveragePct), a.promptsCited);
    let covNow = a.promptsCited / a.promptsTotal;
    if (a.promptsCited === 0) {
      covNow = 1 / a.promptsTotal;
      flooredBaseline = true;
    }
    multiple = Math.round(((targetCited / a.promptsTotal) / covNow) * 10) / 10;
    if (inp.aiVisits !== null && inp.aiVisits > 0) {
      aiVisits = Math.round(inp.aiVisits * multiple);
      if (conv !== null) {
        aiLeadRate = Math.round(conv * inp.aiPremium * 10) / 10;
        aiLeads = (aiVisits * aiLeadRate) / 100;
        if (inp.leadValue !== null) aiAnnual = Math.round(aiLeads * inp.leadValue * 12);
      }
    }
  }

  const totalAnnual =
    gAnnual === null && aiAnnual === null ? null : (gAnnual ?? 0) + (aiAnnual ?? 0);

  return {
    def,
    google: { ctr, visits: gVisits, leads: gLeads, annual: gAnnual },
    ai: {
      targetCited,
      multiple,
      flooredBaseline,
      visits: aiVisits,
      leadRate: aiLeadRate,
      leads: aiLeads,
      annual: aiAnnual,
    },
    totalAnnual,
  };
}

export function computeAll(
  g: GoogleBaseline | null,
  a: AiBaseline,
  inp: ImpactInputs
): ScenarioResult[] {
  return SCENARIOS.map((s) => computeScenario(s, g, a, inp));
}
