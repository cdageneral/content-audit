/**
 * lib/auth/audit.ts — the activity-log writer.
 *
 * recordEvent() attributes the action to the signed-in user (from the session
 * cookie), stamps their company_id (so the log can be scoped per company), and
 * captures ip / user-agent. It NEVER throws and skips silently when there is no
 * signed-in user to attribute.
 */

import type { NextRequest } from 'next/server';
import { ensureAuthTables, insertAudit } from './store';
import { getCurrentUser } from './session';

export function clientIp(req: NextRequest): string | null {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return req.headers.get('x-real-ip');
}

export function userAgent(req: NextRequest): string | null {
  return req.headers.get('user-agent');
}

export async function recordEvent(
  req: NextRequest,
  ev: { action: string; projectId?: string | null; projectName?: string | null; meta?: Record<string, unknown> },
): Promise<void> {
  try {
    const user = await getCurrentUser();
    if (!user) return; // nothing to attribute — don't log an anonymous row
    await ensureAuthTables();
    await insertAudit({
      actorUserId: user.sub,
      actorEmail:  user.email,
      actorName:   user.name,
      companyId:   user.cid,
      action:      ev.action,
      projectId:   ev.projectId ?? null,
      projectName: ev.projectName ?? null,
      meta:        ev.meta ?? null,
      ip:          clientIp(req),
      userAgent:   userAgent(req),
    });
  } catch {
    /* logging must never break the underlying action */
  }
}
