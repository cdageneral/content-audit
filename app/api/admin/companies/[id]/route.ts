/**
 * /api/admin/companies/[id]  — super_admin only
 * PATCH  — update { name?, seatLimit?, expiresAt?, projectIds? }
 *          projectIds (when present) sets EXACTLY which projects belong to this
 *          company (assign + unassign).
 * DELETE — remove a company. Its users are deleted (cascade); its projects are
 *          unassigned (company_id → null), not deleted.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkSuperAdmin } from '@/lib/auth/access';
import {
  ensureAuthTables, getCompanyById, updateCompany, deleteCompany,
  setCompanyProjects, countCompanySeatsUsed, insertAudit,
} from '@/lib/auth/store';
import { parseExpiryInput } from '@/lib/auth/dates';
import { getCurrentUser } from '@/lib/auth/session';
import { clientIp, userAgent } from '@/lib/auth/audit';

const Patch = z.object({
  name:       z.string().min(1).max(160).optional(),
  seatLimit:  z.number().int().min(1).max(10000).optional(),
  expiresAt:  z.union([z.string(), z.null()]).optional(),
  projectIds: z.array(z.string().uuid()).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const company = await getCompanyById(params.id);
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = Patch.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });

  let expiresAt: Date | null | undefined;
  try { expiresAt = parseExpiryInput(parsed.data.expiresAt); }
  catch { return NextResponse.json({ error: 'Invalid expiry date' }, { status: 400 }); }

  // Guard against dropping seats below what's already in use.
  if (parsed.data.seatLimit !== undefined) {
    const used = await countCompanySeatsUsed(params.id);
    if (parsed.data.seatLimit < used) {
      return NextResponse.json(
        { error: `That company already has ${used} user${used === 1 ? '' : 's'}. Remove some before lowering seats to ${parsed.data.seatLimit}.` },
        { status: 400 },
      );
    }
  }

  await updateCompany(params.id, {
    name: parsed.data.name,
    seatLimit: parsed.data.seatLimit,
    expiresAt,
  });
  if (parsed.data.projectIds) await setCompanyProjects(params.id, parsed.data.projectIds);

  const actor = await getCurrentUser();
  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name, companyId: params.id,
    action: 'company.update',
    meta: {
      companyId: params.id,
      changed: {
        name: parsed.data.name, seatLimit: parsed.data.seatLimit,
        expiry: expiresAt === undefined ? undefined : (expiresAt ? expiresAt.toISOString() : 'cleared'),
        projects: parsed.data.projectIds ? parsed.data.projectIds.length : undefined,
      },
    },
    ip: clientIp(req), userAgent: userAgent(req),
  });

  const updated = await getCompanyById(params.id);
  return NextResponse.json({ company: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  const company = await getCompanyById(params.id);
  if (!company) return NextResponse.json({ error: 'Company not found' }, { status: 404 });

  await deleteCompany(params.id);

  const actor = await getCurrentUser();
  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name,
    action: 'company.delete', meta: { companyId: params.id, name: company.name },
    ip: clientIp(req), userAgent: userAgent(req),
  });
  return NextResponse.json({ ok: true });
}
