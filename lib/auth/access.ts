/**
 * lib/auth/access.ts — the company-scoped access wall.
 *
 * No-op when AUTH_ENFORCED is off (open access, current behaviour). When on:
 *   super_admin   → every project, every company
 *   company_admin → every project in THEIR company
 *   client_user   → their company's projects; all by default, or a restricted
 *                   subset if they have project_access grant rows
 * Suspended / revoked / EXPIRED users are rejected (getActiveUser returns null).
 */

import { authEnforced, seesAllProjects, canReachAdmin, isSuperAdmin, type Role } from './config';
import { getActiveUser } from './session';
import { hasProjectAccess, getGrantedProjectIds, getProjectCompanyId } from './store';
import type { SessionClaims } from './jwt';

export interface AccessResult {
  ok: boolean;
  status: number;         // 401 unauthenticated, 403 forbidden
  user: SessionClaims | null;
  reason?: string;
}

const ALLOW_OPEN: AccessResult = { ok: true, status: 200, user: null };

/** Gate a specific project. Allows everything when the flag is off. */
export async function checkProjectAccess(projectId: string): Promise<AccessResult> {
  if (!authEnforced()) return ALLOW_OPEN;
  const user = await getActiveUser();
  if (!user) return { ok: false, status: 401, user: null, reason: 'not signed in' };
  if (seesAllProjects(user.role)) return { ok: true, status: 200, user };

  // Must belong to the company that owns the project.
  const owner = await getProjectCompanyId(projectId);
  if (!owner || owner !== user.cid) {
    return { ok: false, status: 403, user, reason: 'no access to this project' };
  }
  // company_admin sees all of their company's projects.
  if (user.role === 'company_admin') return { ok: true, status: 200, user };

  // client_user: no grants = full company access; grants = whitelist.
  const grants = await getGrantedProjectIds(user.sub);
  if (grants.length === 0) return { ok: true, status: 200, user };
  const granted = await hasProjectAccess(user.sub, projectId);
  return granted
    ? { ok: true, status: 200, user }
    : { ok: false, status: 403, user, reason: 'no access to this project' };
}

/** Require any signed-in, active user. Open when the flag is off. */
export async function checkSignedIn(): Promise<AccessResult> {
  if (!authEnforced()) return ALLOW_OPEN;
  const user = await getActiveUser();
  if (!user) return { ok: false, status: 401, user: null, reason: 'not signed in' };
  return { ok: true, status: 200, user };
}

/** Require admin-panel access (super_admin or company_admin). Open when off. */
export async function checkAdmin(): Promise<AccessResult> {
  if (!authEnforced()) return ALLOW_OPEN;
  const user = await getActiveUser();
  if (!user) return { ok: false, status: 401, user: null, reason: 'not signed in' };
  if (!canReachAdmin(user.role)) return { ok: false, status: 403, user, reason: 'admins only' };
  return { ok: true, status: 200, user };
}

/** Require the super_admin specifically (company management). Open when off. */
export async function checkSuperAdmin(): Promise<AccessResult> {
  if (!authEnforced()) return ALLOW_OPEN;
  const user = await getActiveUser();
  if (!user) return { ok: false, status: 401, user: null, reason: 'not signed in' };
  if (!isSuperAdmin(user.role)) return { ok: false, status: 403, user, reason: 'super admin only' };
  return { ok: true, status: 200, user };
}

export type { Role };
