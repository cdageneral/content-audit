/**
 * lib/auth/config.ts — auth constants + role helpers + the enforcement flag.
 *
 * The whole auth layer is gated behind AUTH_ENFORCED. When it is anything other
 * than 'true', middleware and access checks are no-ops and the app behaves
 * EXACTLY as it does today (open access). Staged-rollout switch: ship with the
 * flag OFF, create your super_admin + companies + users, verify the wall, then
 * set AUTH_ENFORCED=true to go live.
 *
 * Env vars:
 *   AUTH_ENFORCED  'true' turns the login wall + access checks on. Anything else
 *                  (unset / 'false' / '0') = open access, current behaviour.
 *   AUTH_SECRET    HMAC secret used to sign the session cookie. Required for
 *                  login to work at all (you still log in to reach /admin even
 *                  with the wall off). Use a long random value.
 */

export const SESSION_COOKIE = 'ca_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type Role = 'super_admin' | 'company_admin' | 'client_user';
export type UserStatus = 'active' | 'pending' | 'suspended';

/** Roles that can reach the /admin panel. */
export const ADMIN_ROLES: Role[] = ['super_admin', 'company_admin'];

/** True only when the login wall + access checks should be enforced. */
export function authEnforced(): boolean {
  return process.env.AUTH_ENFORCED === 'true';
}

export function isSuperAdmin(role: string | undefined | null): boolean {
  return role === 'super_admin';
}

export function isCompanyAdmin(role: string | undefined | null): boolean {
  return role === 'company_admin';
}

/** Can reach the admin panel (super_admin globally, company_admin for their co). */
export function canReachAdmin(role: string | undefined | null): boolean {
  return role === 'super_admin' || role === 'company_admin';
}

/** Only the super_admin sees every project across every company. */
export function seesAllProjects(role: string | undefined | null): boolean {
  return role === 'super_admin';
}

/** The signing secret, or throw a clear error if it was never configured. */
export function authSecret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error(
      'AUTH_SECRET is not set (or too short). Set a long random AUTH_SECRET env var in Vercel to enable login.',
    );
  }
  return new TextEncoder().encode(s);
}
