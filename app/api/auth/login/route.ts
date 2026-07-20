/**
 * POST /api/auth/login
 * Body: { email, password }
 * Verifies credentials, enforces expiry (user + company), creates a session,
 * sets the httpOnly session cookie, records a `login` event. Works regardless of
 * AUTH_ENFORCED so you can sign in during the staged (flag-off) window.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
  ensureAuthTables, getUserByEmail, getCompanyById, setLastLogin, createSession, insertAudit,
} from '@/lib/auth/store';
import { verifyPassword } from '@/lib/auth/passwords';
import { setSessionCookie, isPast } from '@/lib/auth/session';
import { SESSION_TTL_SECONDS } from '@/lib/auth/config';
import { clientIp, userAgent } from '@/lib/auth/audit';

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: NextRequest) {
  await ensureAuthTables();
  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: 'Email and password required' }, { status: 400 });

  const { email, password } = parsed.data;
  const user = await getUserByEmail(email);

  // Generic message — never reveal whether the email exists.
  const invalid = () => NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  if (!user || user.status === 'suspended') return invalid();
  if (!verifyPassword(password, user.passwordHash)) return invalid();

  // Expiry wall — user's own date, then their company's.
  if (isPast(user.expiresAt)) {
    return NextResponse.json({ error: 'Your access has expired. Please contact your administrator.' }, { status: 403 });
  }
  if (user.companyId) {
    const company = await getCompanyById(user.companyId);
    if (!company) return invalid();
    if (isPast(company.expiresAt)) {
      return NextResponse.json({ error: 'Your organization’s access has expired. Please contact your administrator.' }, { status: 403 });
    }
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  const sid = await createSession(user.id, expiresAt, clientIp(req) ?? undefined, userAgent(req) ?? undefined);

  await setSessionCookie({
    sub: user.id, email: user.email, name: user.name, role: user.role, cid: user.companyId ?? null, sid,
  });
  await setLastLogin(user.id);
  await insertAudit({
    actorUserId: user.id, actorEmail: user.email, actorName: user.name, companyId: user.companyId,
    action: 'login', ip: clientIp(req), userAgent: userAgent(req),
  });

  return NextResponse.json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status },
  });
}
