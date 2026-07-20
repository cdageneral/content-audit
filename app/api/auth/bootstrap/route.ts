/**
 * POST /api/auth/bootstrap
 * Body: { name, email, password }
 * Creates the FIRST super_admin account — but only while no users exist yet.
 * Once any user exists this endpoint is closed (403). Signs the new super_admin
 * in immediately. Super admins have no company (cid = null) and see everything.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { ensureAuthTables, countUsers, createUser, createSession, insertAudit } from '@/lib/auth/store';
import { hashPassword } from '@/lib/auth/passwords';
import { setSessionCookie } from '@/lib/auth/session';
import { SESSION_TTL_SECONDS } from '@/lib/auth/config';
import { clientIp, userAgent } from '@/lib/auth/audit';

const Body = z.object({
  name:     z.string().min(1).max(120),
  email:    z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export async function POST(req: NextRequest) {
  await ensureAuthTables();
  if (await countUsers() > 0) {
    return NextResponse.json({ error: 'Setup already complete — an admin already exists. Ask your administrator to add you.' }, { status: 403 });
  }
  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });
  }
  const { name, email, password } = parsed.data;

  const user = await createUser({
    name, email, role: 'super_admin', status: 'active', companyId: null, passwordHash: hashPassword(password),
  });

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const sid = await createSession(user.id, expiresAt, clientIp(req) ?? undefined, userAgent(req) ?? undefined);
  await setSessionCookie({ sub: user.id, email: user.email, name: user.name, role: user.role, cid: null, sid });
  await insertAudit({
    actorUserId: user.id, actorEmail: user.email, actorName: user.name,
    action: 'login', meta: { bootstrap: true }, ip: clientIp(req), userAgent: userAgent(req),
  });

  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status },
  }, { status: 201 });
}
