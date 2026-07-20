/**
 * /api/admin/users/[id]  — super_admin or company_admin
 * PATCH  — update a user. super_admin may change role, status, name, company,
 *          expiry, project restriction, password. company_admin may update only
 *          client_users IN THEIR OWN company (status, name, expiry, restriction,
 *          password) — never role or company.
 * DELETE — remove a user (same scoping).
 *
 * Guards: the last active super_admin can't be demoted / suspended / deleted;
 * you can't delete yourself; reactivating or moving a user re-checks the target
 * company's seat cap.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db';
import { appUsers } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { checkAdmin } from '@/lib/auth/access';
import { authEnforced } from '@/lib/auth/config';
import {
  ensureAuthTables, listUsersWithAccess, getUserById, updateUser, setGrants,
  getGrantedProjectIds, getCompanyById, countCompanySeatsUsed, getCompanyProjectIds,
  revokeAllSessionsForUser, insertAudit,
} from '@/lib/auth/store';
import { hashPassword } from '@/lib/auth/passwords';
import { parseExpiryInput } from '@/lib/auth/dates';
import { getCurrentUser } from '@/lib/auth/session';
import { clientIp, userAgent } from '@/lib/auth/audit';

const Patch = z.object({
  role:       z.enum(['super_admin', 'company_admin', 'client_user']).optional(),
  status:     z.enum(['active', 'suspended']).optional(),
  name:       z.string().min(1).max(120).optional(),
  companyId:  z.string().uuid().nullable().optional(),
  projectIds: z.array(z.string().uuid()).optional(),
  password:   z.string().min(8).optional(),
  expiresAt:  z.union([z.string(), z.null()]).optional(),
});

async function activeSuperAdminIds(): Promise<string[]> {
  const users = await listUsersWithAccess();
  return users.filter(u => u.role === 'super_admin' && u.status === 'active').map(u => u.id);
}

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const actor = gate.user ?? await getCurrentUser();
  const actingRole = actor?.role ?? (authEnforced() ? null : 'super_admin');
  const actingCompany = actor?.cid ?? null;
  const isSuper = actingRole === 'super_admin';

  const target = await getUserById(params.id);
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // Scope: a company_admin may only touch client_users in their own company.
  if (!isSuper) {
    if (target.companyId !== actingCompany || target.role !== 'client_user') {
      return NextResponse.json({ error: 'You can only manage client users in your own company.' }, { status: 403 });
    }
  }

  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = Patch.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });

  // Fields a company_admin is NOT allowed to change.
  const role      = isSuper ? parsed.data.role : undefined;
  const companyId = isSuper ? parsed.data.companyId : undefined;
  const { status, name, projectIds, password } = parsed.data;

  let expiresAt: Date | null | undefined;
  try { expiresAt = parseExpiryInput(parsed.data.expiresAt); }
  catch { return NextResponse.json({ error: 'Invalid expiry date' }, { status: 400 }); }

  // Guard: don't strip the last active super_admin.
  const supers = await activeSuperAdminIds();
  const strippingLastSuper =
    target.role === 'super_admin' &&
    ((role && role !== 'super_admin') || status === 'suspended') &&
    supers.length <= 1 && supers.includes(target.id);
  if (strippingLastSuper) {
    return NextResponse.json({ error: 'Cannot demote or suspend the last active super admin.' }, { status: 400 });
  }

  // Determine the company the user will belong to after this patch.
  const destCompany = companyId !== undefined ? companyId : target.companyId;

  // Seat re-check when reactivating a suspended user or moving into a company.
  const reactivating = status === 'active' && target.status === 'suspended';
  const moving = companyId !== undefined && companyId !== target.companyId;
  if ((reactivating || moving) && destCompany) {
    const company = await getCompanyById(destCompany);
    if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    const used = await countCompanySeatsUsed(destCompany);
    // The user occupies a seat only if they aren't already an active/pending
    // member of that same company.
    const alreadyCounts = (target.companyId === destCompany) && (target.status === 'active' || target.status === 'pending');
    if (!alreadyCounts && used >= company.seatLimit) {
      return NextResponse.json(
        { error: `Seat limit reached for that company — ${used} of ${company.seatLimit} used.` },
        { status: 409 },
      );
    }
  }

  await updateUser(params.id, {
    role, status, name, companyId, expiresAt,
    passwordHash: password ? hashPassword(password) : undefined,
  });

  // Setting a password on a pending user activates them.
  if (password && target.status === 'pending' && !status) {
    await db.update(appUsers).set({ status: 'active' }).where(eq(appUsers.id, params.id));
  }
  // Suspending immediately kills the user's live sessions.
  if (status === 'suspended') await revokeAllSessionsForUser(params.id);

  // Project restriction — only for client_users; must be projects of their company.
  if (projectIds) {
    const finalRole = role ?? target.role;
    if (finalRole === 'client_user' && destCompany) {
      const companyProjects = new Set(await getCompanyProjectIds(destCompany));
      const bad = projectIds.filter(p => !companyProjects.has(p));
      if (bad.length) return NextResponse.json({ error: 'Some selected projects do not belong to this company.' }, { status: 400 });
      await setGrants(params.id, projectIds);
    } else if (finalRole !== 'client_user') {
      await setGrants(params.id, []); // admins are never restricted
    }
  }
  // Moving companies invalidates old grants (they pointed at the old company).
  if (moving) await setGrants(params.id, projectIds && (role ?? target.role) === 'client_user' ? projectIds : []);

  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name, companyId: destCompany,
    action: 'user.update',
    meta: { targetUserId: params.id, targetEmail: target.email,
            changed: { role, status, name: name ? true : undefined, company: companyId,
                       expiry: expiresAt === undefined ? undefined : (expiresAt ? expiresAt.toISOString() : 'cleared'),
                       password: password ? true : undefined,
                       restriction: projectIds ? projectIds.length : undefined } },
    ip: clientIp(req), userAgent: userAgent(req),
  });

  const grants = await getGrantedProjectIds(params.id);
  const updated = await getUserById(params.id);
  return NextResponse.json({
    user: updated && {
      id: updated.id, name: updated.name, email: updated.email, role: updated.role,
      status: updated.status, companyId: updated.companyId, expiresAt: updated.expiresAt, projectIds: grants,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const actor = gate.user ?? await getCurrentUser();
  const isSuper = (actor?.role ?? (authEnforced() ? null : 'super_admin')) === 'super_admin';
  const actingCompany = actor?.cid ?? null;

  const target = await getUserById(params.id);
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  if (!isSuper && (target.companyId !== actingCompany || target.role !== 'client_user')) {
    return NextResponse.json({ error: 'You can only remove client users in your own company.' }, { status: 403 });
  }
  if (actor && actor.sub === params.id) {
    return NextResponse.json({ error: 'You cannot delete your own account.' }, { status: 400 });
  }
  const supers = await activeSuperAdminIds();
  if (target.role === 'super_admin' && supers.length <= 1 && supers.includes(target.id)) {
    return NextResponse.json({ error: 'Cannot delete the last active super admin.' }, { status: 400 });
  }

  await db.delete(appUsers).where(eq(appUsers.id, params.id)); // grants + sessions cascade
  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name, companyId: target.companyId,
    action: 'user.delete', meta: { targetUserId: params.id, targetEmail: target.email },
    ip: clientIp(req), userAgent: userAgent(req),
  });
  return NextResponse.json({ ok: true });
}
