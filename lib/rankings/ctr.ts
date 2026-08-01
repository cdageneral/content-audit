// ─────────────────────────────────────────────────────────────
//  Published organic CTR curve — the ONE modelled input in the
//  Rankings panel, and it is labelled as such everywhere it shows.
//
//  Everything else in this panel is an observed fact from a scan.
//  Estimated traffic is not: it multiplies a real search volume by a
//  PUBLISHED AVERAGE click-through rate for a ranking position. Real CTR
//  varies enormously by query intent, brand strength, and what else is on
//  the SERP, so treat the output as a size comparison between keywords,
//  never as a traffic forecast.
//
//  Curve source: First Page Sage, "Google Click-Through Rates (CTRs) by
//  Ranking Position", updated 2025-05-28 — a meta-analysis of Backlinko,
//  Sistrix, WordStream, BrightLocal, LocalIQ and their own client data.
//  Sample size is not disclosed by the publisher; that limitation is
//  stated in the UI rather than hidden.
//  https://firstpagesage.com/reports/google-click-through-rates-ctrs-by-ranking-position/
//
//  Deliberately page-1 only. Published curves stop at position 10 and the
//  numbers below it are rounding noise, so positions 11+ return null and
//  render "—" instead of an invented tail.
//
//  AI Overviews are the known distortion: measured organic CTR on SERPs
//  carrying an AI Overview ran 0.61% (uncited) / 0.70% (cited) against
//  1.62% where none appeared — Seer Interactive, 3,119 search terms and
//  25.1M impressions, June 2024 → September 2025. The panel therefore
//  reports how much of the estimate sits on AIO SERPs instead of quietly
//  applying a second model on top of the first.
//  https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-september-2025-update
// ─────────────────────────────────────────────────────────────

/** Published label for the curve, rendered in the UI footnote. */
export const CTR_SOURCE = "First Page Sage, updated May 2025";
export const CTR_SOURCE_URL =
  "https://firstpagesage.com/reports/google-click-through-rates-ctrs-by-ranking-position/";
export const AIO_CTR_SOURCE = "Seer Interactive, September 2025";
export const AIO_CTR_SOURCE_URL =
  "https://www.seerinteractive.com/insights/aio-impact-on-google-ctr-september-2025-update";

/** Average organic CTR by position, as a fraction. Positions 1–10 only. */
const CURVE: Record<number, number> = {
  1: 0.398,
  2: 0.187,
  3: 0.102,
  4: 0.072,
  5: 0.051,
  6: 0.044,
  7: 0.03,
  8: 0.021,
  9: 0.019,
  10: 0.016,
};

/** Published CTR for a position, or null where no published figure exists. */
export function ctrFor(position: number): number | null {
  if (!Number.isFinite(position)) return null;
  return CURVE[Math.round(position)] ?? null;
}

/**
 * Modelled monthly clicks = verified volume × published CTR for the
 * position. Returns null — never 0 — when either input is missing, so the
 * UI can distinguish "no estimate" from "an estimate of nothing".
 */
export function estTraffic(position: number, volume: number | null): number | null {
  if (volume === null || !Number.isFinite(volume) || volume <= 0) return null;
  const ctr = ctrFor(position);
  if (ctr === null) return null;
  return Math.round(volume * ctr);
}

// ── Optional AI Overview adjustment (OFF by default) ─────────
//
//  Seer Interactive's measured organic CTR, Q3 2025, across 3,119 search
//  terms and 25.1M impressions: 1.62% where no AI Overview appeared,
//  0.70% where one appeared and the brand was cited, 0.61% where one
//  appeared and it was not. The ratios below are those figures, nothing
//  interpolated.
//
//  This is a SECOND model layered on the CTR curve, so it stays off unless
//  the user turns it on, and the UI names both sources when it is on. Seer
//  measured informational/educational queries — the segment most exposed to
//  AI Overviews — so on transactional keyword sets the discount is likely
//  too harsh. That is a judgement call the user makes, not one hidden in a
//  default.

export const AIO_CTR_NONE = 0.0162;
export const AIO_CTR_CITED = 0.007;
export const AIO_CTR_UNCITED = 0.0061;

/** Multiplier applied to a page-1 estimate when the SERP carries an AI answer. */
export function aioFactor(aiPresent: boolean, cited: boolean): number {
  if (!aiPresent) return 1;
  return (cited ? AIO_CTR_CITED : AIO_CTR_UNCITED) / AIO_CTR_NONE;
}

/** Rounded AIO multipliers for display, e.g. "×0.38". */
export const AIO_FACTOR_CITED = Math.round((AIO_CTR_CITED / AIO_CTR_NONE) * 100) / 100;
export const AIO_FACTOR_UNCITED = Math.round((AIO_CTR_UNCITED / AIO_CTR_NONE) * 100) / 100;

/**
 * Estimated clicks with the AI Overview discount applied. Same null rules as
 * estTraffic — a keyword with no published CTR stays null rather than 0.
 */
export function estTrafficAio(
  position: number,
  volume: number | null,
  aiPresent: boolean,
  cited: boolean
): number | null {
  const base = estTraffic(position, volume);
  if (base === null) return null;
  return Math.round(base * aioFactor(aiPresent, cited));
}
