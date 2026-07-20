/**
 * /api/admin/companies  — super_admin only
 * GET  — list companies with seat usage + project counts, plus all projects
 *        (for the assignment UI)
 * POST — create a company { name, seatLimit, expiresAt? }
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { checkSuperAdmin } from '@/lib/auth/access';
import {
  ensureAuthTables, listCompanies, createCompany, projectPickerList, insertAudit,
} from '@/lib/auth/store';
import { parseExpiryInput } from '@/lib/auth/dates';
import { getCurrentUser } from '@/lib/auth/session';
import { clientIp, userAgent } from '@/lib/auth/audit';

const CreateCompany = z.object({
  name:      z.string().min(1).max(160),
  seatLimit: z.number().int().min(1).max(10000),
  expiresAt: z.union([z.string(), z.null()]).optional(),
});

export async function GET() {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();
  const [companiesList, projects] = await Promise.all([listCompanies(), projectPickerList()]);
  return NextResponse.json({ companies: companiesList, projects });
}

export async function POST(req: NextRequest) {
  const gate = await checkSuperAdmin();
  if (!gate.ok) return NextResponse.json({ error: gate.reason }, { status: gate.status });
  await ensureAuthTables();

  let json: unknown;
  try { json = await req.json(); } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }); }
  const parsed = CreateCompany.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid input' }, { status: 400 });

  let expiresAt: Date | null | undefined;
  try { expiresAt = parseExpiryInput(parsed.data.expiresAt); }
  catch { return NextResponse.json({ error: 'Invalid expiry date' }, { status: 400 }); }

  const company = await createCompany({
    name: parsed.data.name,
    seatLimit: parsed.data.seatLimit,
    expiresAt: expiresAt ?? null,
  });

  const actor = await getCurrentUser();
  await insertAudit({
    actorUserId: actor?.sub, actorEmail: actor?.email, actorName: actor?.name, companyId: company.id,
    action: 'company.create',
    meta: { companyId: company.id, name: company.name, seatLimit: company.seatLimit },
    ip: clientIp(req), userAgent: userAgent(req),
  });

  return NextResponse.json({ company }, { status: 201 });
}
