/**
 * GET /api/admin/activity  — super_admin or company_admin
 * Returns real audit_events, newest first. super_admin sees everything;
 * company_admin sees only their own company's events. Optional ?action= filter
 * and ?limit=.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/auth/access';
import { authEnforced } from '@/lib/auth/config';
import { ensureAuthTables, listAudit, projectNames } from '@/lib/auth/store';
import { getCurrentUser } from '@/lib/auth/session';

export async function GET(req: NextRequest) {
  const gate = await checkAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const actor = gate.user ?? await getCurrentUser();
  const isSuper = (actor?.role ?? (authEnforced() ? null : 'super_admin')) === 'super_admin';
  const companyId = isSuper ? null : (actor?.cid ?? null);

  const action = req.nextUrl.searchParams.get('action') ?? undefined;
  const limitRaw = Number(req.nextUrl.searchParams.get('limit') ?? '200');
  const limit = Number.isFinite(limitRaw) ? limitRaw : 200;

  const events = await listAudit({ action, limit, companyId });

  const missing = Array.from(new Set(events.filter(e => e.projectId && !e.projectName).map(e => e.projectId as string)));
  const names = missing.length ? await projectNames(missing) : {};

  return NextResponse.json({
    events: events.map(e => ({
      id: e.id, action: e.action, actorName: e.actorName, actorEmail: e.actorEmail,
      projectId: e.projectId, projectName: e.projectName ?? (e.projectId ? names[e.projectId] ?? null : null),
      meta: e.meta, ip: e.ip, userAgent: e.userAgent, createdAt: e.createdAt,
    })),
  });
}
