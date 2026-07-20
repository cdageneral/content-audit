/**
 * POST /api/auth/logout
 * Revokes the current session, records a `logout` event, clears the cookie.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { getCurrentUser, clearSessionCookie } from '@/lib/auth/session';
import { ensureAuthTables, revokeSession, insertAudit } from '@/lib/auth/store';
import { clientIp, userAgent } from '@/lib/auth/audit';

export async function POST(req: NextRequest) {
  try {
    const user = await getCurrentUser();
    if (user) {
      await ensureAuthTables();
      if (user.sid) await revokeSession(user.sid);
      await insertAudit({
        actorUserId: user.sub, actorEmail: user.email, actorName: user.name, companyId: user.cid,
        action: 'logout', ip: clientIp(req), userAgent: userAgent(req),
      });
    }
  } catch { /* best-effort */ }
  clearSessionCookie();
  return NextResponse.json({ ok: true });
}
