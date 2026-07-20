/**
 * /api/admin/users  — super_admin or company_admin
 * GET  — list users (all for super_admin; own company for company_admin) with
 *        their role, status, company, expiry, grants, last login. Returns the
 *        project picker (scoped) and, for super_admin, the companies list.
 * POST — create a user.
 *        super_admin  : role ∈ {company_admin, client_user}, companyId required.
 *        company_admin: always creates a client_user in THEIR OWN company.
 *        Seat cap enforced against the target company. Optional temp password
 *        (no password ⇒ 'pending' until one is set). Optional per-user expiry.
 *        Optional project restriction (client_user only; must be company projects).
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkAdmin } from '@/lib/auth/access';
import { authEnforced } from '@/lib/auth/config';
import {
  ensureAuthTables, listUsersWithAccess, createUser, setGrants, insertAudit, getUserByEmail,
  projectPickerList, listCompanies, getCompanyById, countCompanySeatsUsed, getCompanyProjectIds,
} from '@/lib/auth/store';
import { hashPassword } from '@/lib/auth/passwords';
import { parseExpiryInput } from '@/lib/auth/dates';
import { getCurrentUser } from '@/lib/auth/session';
import { clientIp, userAgent } from '@/lib/auth/audit';

const CreateUser = z.object({
  name:       z.string().min(1).max(120),
  email:      z.string().email(),
  role:       z.enum(['super_admin', 'company_admin', 'client_user']).optional(),
  companyId:  z.string().uuid().optional(),
  projectIds: z.array(z.string().uuid()).optional().default([]),
  password:   z.string().min(8).optional(),
  expiresAt:  z.union([z.string(), z.null()]).optional(),
});

export async function GET() {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const actor = gate.user ?? await getCurrentUser();
  const isSuper = (actor?.role ?? (authEnforced() ? null : 'super_admin')) === 'super_admin';
  const scopeCompany = isSuper ? null : (actor?.cid ?? null);

  const [users, projects] = await Promise.all([
    listUsersWithAccess(scopeCompany),
    projectPickerList(scopeCompany),
  ]);
  const companies = isSuper ? await listCompanies() : undefined;

  return NextResponse.json({
    users, projects, companies,
    me: { role: actor?.role ?? 'super_admin', companyId: actor?.cid ?? null },
  });
}

export async function POST(req: NextRequest) {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const actor = gate.user ?? await getCurrentUser();
  const actingRole = actor?.role ?? (authEnforced() ? null : 'super_admin');
  const actingCompany = actor?.cid ?? null;
  if (!actingRole) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = CreateUser.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  const { name, email, projectIds, password } = parsed.data;

  // Resolve the target role + company from who is acting.
  // super_admins belong to no company (companyId null); everyone else does.
  let role: 'super_admin' | 'company_admin' | 'client_user';
  let companyId: string | null;
  if (actingRole === 'super_admin') {
    role = parsed.data.role ?? 'client_user';
    if (role === 'super_admin') {
      companyId = null; // peer admin — no company, no seat, no grants
    } else {
      if (!parsed.data.companyId) return NextResponse.json({ error: 'Choose a company for this user.' }, { status: 400 });
      companyId = parsed.data.companyId;
    }
  } else if (actingRole === 'company_admin') {
    role = 'client_user'; // company admins can only add client users
    if (!actingCompany) return NextResponse.json({ error: 'Your account is not attached to a company.' }, { status: 400 });
    companyId = actingCompany;
  } else {
    return NextResponse.json({ error: 'Admins only' }, { status: 403 });
  }

  if (await getUserByEmail(email)) {
    return NextResponse.json({ error: 'A user with that email already exists.' }, { status: 409 });
  }

  // Company + seat checks only apply to company-scoped users (not super_admins).
  if (companyId) {
    const company = await getCompanyById(companyId);
    if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });
    const used = await countCompanySeatsUsed(companyId);
    if (used >= company.seatLimit) {
      return NextResponse.json(
        { error: `Seat limit reached — ${used} of ${company.seatLimit} used. Remove a user or raise this company's seats.` },
        { status: 409 },
      );
    }
  }

  // A restriction set is only meaningful for client_user, and must be company projects.
  let grantIds: string[] = [];
  if (role === 'client_user' && companyId && projectIds.length) {
    const companyProjects = new Set(await getCompanyProjectIds(companyId));
    const bad = projectIds.filter(p => !companyProjects.has(p));
    if (bad.length) return NextResponse.json({ error: 'Some selected projects do not belong to this company.' }, { status: 400 });
    grantIds = projectIds;
  }

  let expiresAt: Date | null | undefined;
  try { expiresAt = parseExpiryInput(parsed.data.expiresAt); }
  catch { return NextResponse.json({ error: 'Invalid expiry date' }, { status: 400 }); }

  const user = await createUser({
    name, email, role, companyId,
    status: password ? 'active' : 'pending',
    passwordHash: password ? hashPassword(password) : null,
    expiresAt: expiresAt ?? null,
  });
  if (grantIds.length) await setGrants(user.id, grantIds);

  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name, companyId,
    action: 'user.invite',
    meta: { targetUserId: user.id, targetEmail: user.email, role, restricted: grantIds.length },
    ip: clientIp(req), userAgent: userAgent(req),
  });

  return NextResponse.json({
    user: {
      id: user.id, name: user.name, email: user.email, role: user.role, status: user.status,
      companyId, expiresAt: user.expiresAt, projectIds: grantIds,
    },
  }, { status: 201 });
}
