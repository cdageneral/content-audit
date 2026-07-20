/**
 * POST /api/auth/change-password  — self-service, any signed-in active user.
 * Body: { currentPassword, newPassword }
 * Lets a user (typically after first login with an admin-set temp password)
 * change their own password. Verifies the current password first.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getActiveUser } from '@/lib/auth/session';
import { ensureAuthTables, getUserById, updateUser, insertAudit } from '@/lib/auth/store';
import { hashPassword, verifyPassword } from '@/lib/auth/passwords';
import { clientIp, userAgent } from '@/lib/auth/audit';

const Body = z.object({
  currentPassword: z.string().min(1),
  newPassword:     z.string().min(8, 'New password must be at least 8 characters'),
});

export async function POST(req: NextRequest) {
  await ensureAuthTables();
  // Always require a real, active session here (independent of AUTH_ENFORCED).
  const me = await getActiveUser();
  if (!me) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = Body.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });

  const user = await getUserById(me.sub);
  if (!user) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (!verifyPassword(parsed.data.currentPassword, user.passwordHash)) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 400 });
  }

  await updateUser(user.id, { passwordHash: hashPassword(parsed.data.newPassword) });
  await insertAudit({
    actorUserId: user.id, actorEmail: user.email, actorName: user.name, companyId: user.companyId,
    action: 'user.password_change', ip: clientIp(req), userAgent: userAgent(req),
  });
  return NextResponse.json({ ok: true });
}
