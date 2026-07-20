/**
 * lib/auth/session.ts — session cookie helpers for node route handlers.
 *
 * Middleware verifies the token itself (edge, via jwt.ts). These helpers run in
 * node route handlers: set/clear the cookie and read the current user.
 *   getCurrentUser() — signature-only (fast, no DB).
 *   getActiveUser()  — additionally confirms, against the DB, that the session
 *                      is live, the user is still 'active', and neither the user
 *                      nor their company has EXPIRED. Use before any privileged
 *                      action so a suspended / expired user is blocked at once.
 */

import { cookies } from 'next/headers';
import { SESSION_COOKIE, SESSION_TTL_SECONDS } from './config';
import { signSessionToken, verifySessionToken, type SessionClaims } from './jwt';
import { isSessionActive, getUserById, getCompanyById } from './store';

export async function setSessionCookie(claims: SessionClaims): Promise<void> {
  const token = await signSessionToken(claims);
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path:     '/',
    maxAge:   SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(): void {
  cookies().set(SESSION_COOKIE, '', {
    httpOnly: true, secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax', path: '/', maxAge: 0,
  });
}

/** Identity from the signed cookie (no DB). null if no/invalid cookie. */
export async function getCurrentUser(): Promise<SessionClaims | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionToken(token);
}

/** True when this expiry date is in the past. null/undefined = never expires. */
export function isPast(date: Date | null | undefined): boolean {
  return !!date && date.getTime() <= Date.now();
}

/**
 * DB-confirmed active user. Returns null if the session is revoked/expired, the
 * user is suspended, or the user's own OR their company's expiry date has passed.
 * Reflects any role/company change since the token was minted.
 */
export async function getActiveUser(): Promise<SessionClaims | null> {
  const claims = await getCurrentUser();
  if (!claims) return null;
  if (claims.sid && !(await isSessionActive(claims.sid))) return null;

  const user = await getUserById(claims.sub);
  if (!user || user.status !== 'active') return null;
  if (isPast(user.expiresAt)) return null;

  if (user.companyId) {
    const company = await getCompanyById(user.companyId);
    if (!company || isPast(company.expiresAt)) return null;
  }

  return { ...claims, role: user.role, cid: user.companyId ?? null };
}
