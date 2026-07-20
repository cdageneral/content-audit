/**
 * lib/auth/dates.ts — parse an incoming expiry value from the admin UI.
 *
 * Accepts:
 *   undefined            → leave unchanged (returns undefined)
 *   null / '' / 'never'  → clear the expiry (never expires) (returns null)
 *   'YYYY-MM-DD'         → end of that day, UTC (access lasts THROUGH that date)
 *   full ISO string      → that exact instant
 * Returns undefined (no change), null (clear), or a Date. Throws on garbage.
 */
export function parseExpiryInput(v: unknown): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== 'string') throw new Error('Invalid expiry');
  const s = v.trim();
  if (s === '' || s.toLowerCase() === 'never') return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T23:59:59.000Z`);
    if (isNaN(d.getTime())) throw new Error('Invalid expiry date');
    return d;
  }
  const d = new Date(s);
  if (isNaN(d.getTime())) throw new Error('Invalid expiry date');
  return d;
}
