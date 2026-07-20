/**
 * GET /api/auth/me
 * Returns the current user (or null), whether enforcement is on, and whether the
 * app still needs its first super_admin (drives the sign-in page's bootstrap
 * form). Public so the sign-in page can call it while signed out.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { getActiveUser } from '@/lib/auth/session';
import { authEnforced } from '@/lib/auth/config';
import { ensureAuthTables, countUsers } from '@/lib/auth/store';

export async function GET() {
  let needsBootstrap = false;
  try {
    await ensureAuthTables();
    needsBootstrap = (await countUsers()) === 0;
  } catch { /* DB not reachable — treat as not-needing-bootstrap */ }

  const user = await getActiveUser();
  return NextResponse.json({
    enforced: authEnforced(),
    needsBootstrap,
    user: user ? { id: user.sub, name: user.name, email: user.email, role: user.role, companyId: user.cid } : null,
  });
}
