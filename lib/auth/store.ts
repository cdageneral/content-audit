/**
 * lib/auth/store.ts — auth data access + runtime table creation.
 *
 * Like the app's projects table, the auth tables are created at runtime with
 * CREATE TABLE IF NOT EXISTS (the app builds with `next build` only, no
 * migration step). Every auth/admin route calls ensureAuthTables() first. All
 * statements are idempotent.
 *
 * Company-scoped model — see db/schema.ts for the shape and the roles.
 */

import { db } from '@/db';
import {
  companies, appUsers, projectAccess, authSessions, auditEvents, projects,
} from '@/db/schema';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Role, UserStatus } from './config';

let ensured = false;

export async function ensureAuthTables(): Promise<void> {
  if (ensured) return;

  // Enums. Create if missing; also add values defensively so an older enum from
  // a prior attempt is upgraded rather than colliding.
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE user_role AS ENUM ('super_admin','company_admin','client_user');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
  await db.execute(sql`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin'`);
  await db.execute(sql`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'company_admin'`);
  await db.execute(sql`ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'client_user'`);
  await db.execute(sql`DO $$ BEGIN
    CREATE TYPE user_status AS ENUM ('active','pending','suspended');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS companies (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name       text NOT NULL,
    seat_limit integer NOT NULL DEFAULT 1,
    expires_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS app_users (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email         text NOT NULL UNIQUE,
    name          text NOT NULL,
    password_hash text,
    role          user_role   NOT NULL DEFAULT 'client_user',
    status        user_status NOT NULL DEFAULT 'active',
    company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,
    expires_at    timestamptz,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  )`);
  // Idempotent column adds for any app_users table created before this version.
  await db.execute(sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE app_users ADD COLUMN IF NOT EXISTS expires_at timestamptz`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS app_users_company_idx ON app_users(company_id)`);

  // Add company_id to the app's existing projects table (skips cleanly if the
  // projects table doesn't exist yet — the app creates it on first use).
  await db.execute(sql`ALTER TABLE IF EXISTS projects ADD COLUMN IF NOT EXISTS company_id uuid REFERENCES companies(id) ON DELETE SET NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS projects_company_idx ON projects(company_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_access (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    project_id uuid NOT NULL REFERENCES projects(id)  ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS project_access_user_project_uq
    ON project_access(user_id, project_id)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS auth_sessions (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    ip         text,
    user_agent text
  )`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS audit_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid,
    actor_email   text,
    actor_name    text,
    company_id    uuid,
    action        text NOT NULL,
    project_id    uuid,
    project_name  text,
    meta          jsonb,
    ip            text,
    user_agent    text,
    created_at    timestamptz NOT NULL DEFAULT now()
  )`);
  await db.execute(sql`ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS company_id uuid`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_events_created_idx ON audit_events(created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS audit_events_company_idx ON audit_events(company_id)`);

  ensured = true;
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function countUsers(): Promise<number> {
  const res = await db.execute(sql`select count(*)::int as c from app_users`);
  const rows = (res as unknown as { rows?: Array<Record<string, unknown>> }).rows
    ?? (res as unknown as Array<Record<string, unknown>>);
  const first = Array.isArray(rows) ? rows[0] : undefined;
  const c = first != null ? Number((first as Record<string, unknown>).c) : 0;
  return Number.isFinite(c) ? c : 0;
}

export async function getUserByEmail(email: string) {
  const rows = await db.select().from(appUsers).where(eq(appUsers.email, email.toLowerCase())).limit(1);
  return rows[0] ?? null;
}

export async function getUserById(id: string) {
  const rows = await db.select().from(appUsers).where(eq(appUsers.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function createUser(input: {
  name: string; email: string; role: Role; status: UserStatus;
  companyId?: string | null; expiresAt?: Date | null; passwordHash?: string | null;
}) {
  const [row] = await db.insert(appUsers).values({
    name:         input.name,
    email:        input.email.toLowerCase(),
    role:         input.role,
    status:       input.status,
    companyId:    input.companyId ?? null,
    expiresAt:    input.expiresAt ?? null,
    passwordHash: input.passwordHash ?? null,
  }).returning();
  return row;
}

export async function updateUser(id: string, patch: {
  role?: Role; status?: UserStatus; name?: string;
  companyId?: string | null; expiresAt?: Date | null; passwordHash?: string | null;
}) {
  const set: Record<string, unknown> = {};
  if (patch.role      !== undefined) set.role = patch.role;
  if (patch.status    !== undefined) set.status = patch.status;
  if (patch.name      !== undefined) set.name = patch.name;
  if (patch.companyId !== undefined) set.companyId = patch.companyId;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  if (patch.passwordHash !== undefined) set.passwordHash = patch.passwordHash;
  if (Object.keys(set).length === 0) return;
  await db.update(appUsers).set(set).where(eq(appUsers.id, id));
}

export async function setLastLogin(id: string) {
  await db.update(appUsers).set({ lastLoginAt: new Date() }).where(eq(appUsers.id, id));
}

/**
 * Users with their granted project ids. Scoped to one company when companyId is
 * given (the company_admin view); all users when omitted (super_admin view).
 */
export async function listUsersWithAccess(companyId?: string | null) {
  const users = companyId
    ? await db.select().from(appUsers).where(eq(appUsers.companyId, companyId)).orderBy(desc(appUsers.createdAt))
    : await db.select().from(appUsers).orderBy(desc(appUsers.createdAt));
  const grants = await db.select().from(projectAccess);
  const byUser = new Map<string, string[]>();
  for (const g of grants) {
    const list = byUser.get(g.userId) ?? [];
    list.push(g.projectId);
    byUser.set(g.userId, list);
  }
  return users.map(u => ({
    id: u.id, name: u.name, email: u.email, role: u.role, status: u.status,
    companyId: u.companyId, expiresAt: u.expiresAt,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    projectIds: byUser.get(u.id) ?? [],
  }));
}

// ─── Companies ────────────────────────────────────────────────────────────────

export async function getCompanyById(id: string) {
  const rows = await db.select().from(companies).where(eq(companies.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listCompanies() {
  const rows = await db.select().from(companies).orderBy(desc(companies.createdAt));
  // seat usage (active + pending) and project counts, per company
  const seatRows = await db.execute(sql`
    select company_id, count(*)::int as c
    from app_users
    where company_id is not null and status in ('active','pending')
    group by company_id`);
  const projRows = await db.execute(sql`
    select company_id, count(*)::int as c
    from projects where company_id is not null group by company_id`);
  const seatMap = toCountMap(seatRows);
  const projMap = toCountMap(projRows);
  return rows.map(c => ({
    id: c.id, name: c.name, seatLimit: c.seatLimit, expiresAt: c.expiresAt,
    createdAt: c.createdAt,
    seatsUsed: seatMap.get(c.id) ?? 0,
    projectCount: projMap.get(c.id) ?? 0,
  }));
}

function toCountMap(res: unknown): Map<string, number> {
  const rows = (res as { rows?: Array<Record<string, unknown>> }).rows
    ?? (res as unknown as Array<Record<string, unknown>>);
  const m = new Map<string, number>();
  if (Array.isArray(rows)) {
    for (const r of rows) {
      const id = r.company_id as string | null;
      if (id) m.set(id, Number(r.c) || 0);
    }
  }
  return m;
}

export async function createCompany(input: { name: string; seatLimit: number; expiresAt?: Date | null }) {
  const [row] = await db.insert(companies).values({
    name: input.name,
    seatLimit: input.seatLimit,
    expiresAt: input.expiresAt ?? null,
  }).returning();
  return row;
}

export async function updateCompany(id: string, patch: { name?: string; seatLimit?: number; expiresAt?: Date | null }) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.name      !== undefined) set.name = patch.name;
  if (patch.seatLimit !== undefined) set.seatLimit = patch.seatLimit;
  if (patch.expiresAt !== undefined) set.expiresAt = patch.expiresAt;
  await db.update(companies).set(set).where(eq(companies.id, id));
}

export async function deleteCompany(id: string) {
  // app_users cascade (company_id ON DELETE CASCADE). projects.company_id is set
  // null (projects survive, become unassigned) — matching ON DELETE SET NULL.
  await db.delete(companies).where(eq(companies.id, id));
}

/** Active + pending users occupying a seat in a company. */
export async function countCompanySeatsUsed(companyId: string): Promise<number> {
  const res = await db.execute(sql`
    select count(*)::int as c from app_users
    where company_id = ${companyId} and status in ('active','pending')`);
  const rows = (res as { rows?: Array<Record<string, unknown>> }).rows
    ?? (res as unknown as Array<Record<string, unknown>>);
  const first = Array.isArray(rows) ? rows[0] : undefined;
  return first ? Number((first as Record<string, unknown>).c) || 0 : 0;
}

// ─── Company ↔ project assignment ─────────────────────────────────────────────

export async function getCompanyProjectIds(companyId: string): Promise<string[]> {
  const rows = await db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId));
  return rows.map(r => r.id);
}

/** Set exactly which projects belong to a company (assign + unassign). */
export async function setCompanyProjects(companyId: string, projectIds: string[]) {
  // Unassign any project currently on this company but not in the new set.
  await db.execute(sql`
    update projects set company_id = null
    where company_id = ${companyId}
      ${projectIds.length ? sql`and id not in (${sql.join(projectIds.map(id => sql`${id}`), sql`, `)})` : sql``}`);
  // Assign the requested projects to this company.
  if (projectIds.length) {
    await db.update(projects).set({ companyId }).where(inArray(projects.id, projectIds));
  }
}

// ─── Grants (per-user restriction inside a company) ───────────────────────────

export async function getGrantedProjectIds(userId: string): Promise<string[]> {
  const rows = await db.select({ p: projectAccess.projectId }).from(projectAccess).where(eq(projectAccess.userId, userId));
  return rows.map(r => r.p);
}

/** Replace a user's grant set with exactly `projectIds` (empty = no restriction). */
export async function setGrants(userId: string, projectIds: string[]) {
  const current = await getGrantedProjectIds(userId);
  const want = new Set(projectIds);
  const have = new Set(current);
  const toAdd = projectIds.filter(p => !have.has(p));
  const toRemove = current.filter(p => !want.has(p));
  if (toAdd.length) {
    await db.insert(projectAccess).values(toAdd.map(p => ({ userId, projectId: p }))).onConflictDoNothing();
  }
  if (toRemove.length) {
    await db.delete(projectAccess).where(and(eq(projectAccess.userId, userId), inArray(projectAccess.projectId, toRemove)));
  }
}

export async function hasProjectAccess(userId: string, projectId: string): Promise<boolean> {
  const rows = await db.select({ id: projectAccess.id }).from(projectAccess)
    .where(and(eq(projectAccess.userId, userId), eq(projectAccess.projectId, projectId))).limit(1);
  return rows.length > 0;
}

/** The company that owns a project (null if unassigned / not found). */
export async function getProjectCompanyId(projectId: string): Promise<string | null> {
  const rows = await db.select({ c: projects.companyId }).from(projects).where(eq(projects.id, projectId)).limit(1);
  return rows.length ? (rows[0].c ?? null) : null;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export async function createSession(userId: string, expiresAt: Date, ip?: string, userAgent?: string): Promise<string> {
  const [row] = await db.insert(authSessions)
    .values({ userId, expiresAt, ip: ip ?? null, userAgent: userAgent ?? null })
    .returning({ id: authSessions.id });
  return row.id;
}

export async function revokeSession(sid: string) {
  if (!sid) return;
  await db.update(authSessions).set({ revokedAt: new Date() }).where(eq(authSessions.id, sid));
}

/** Revoke every live session for a user (used when suspending). */
export async function revokeAllSessionsForUser(userId: string) {
  await db.update(authSessions).set({ revokedAt: new Date() })
    .where(and(eq(authSessions.userId, userId), isNull(authSessions.revokedAt)));
}

export async function isSessionActive(sid: string): Promise<boolean> {
  if (!sid) return false;
  const rows = await db.select({ id: authSessions.id }).from(authSessions)
    .where(and(eq(authSessions.id, sid), isNull(authSessions.revokedAt), sql`${authSessions.expiresAt} > now()`))
    .limit(1);
  return rows.length > 0;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export async function insertAudit(row: {
  actorUserId?: string | null; actorEmail?: string | null; actorName?: string | null;
  companyId?: string | null; action: string; projectId?: string | null; projectName?: string | null;
  meta?: Record<string, unknown> | null; ip?: string | null; userAgent?: string | null;
}) {
  await db.insert(auditEvents).values({
    actorUserId: row.actorUserId ?? null,
    actorEmail:  row.actorEmail  ?? null,
    actorName:   row.actorName   ?? null,
    companyId:   row.companyId   ?? null,
    action:      row.action,
    projectId:   row.projectId   ?? null,
    projectName: row.projectName ?? null,
    meta:        row.meta ?? null,
    ip:          row.ip ?? null,
    userAgent:   row.userAgent ?? null,
  });
}

/** Activity log. Scoped to one company when companyId is given. */
export async function listAudit(opts: { limit?: number; action?: string; companyId?: string | null } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  const conds = [];
  if (opts.action && opts.action !== 'all') conds.push(eq(auditEvents.action, opts.action));
  if (opts.companyId) conds.push(eq(auditEvents.companyId, opts.companyId));
  const where = conds.length ? and(...conds) : undefined;
  const q = db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit);
  return where ? await q.where(where) : await q;
}

export async function projectNames(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const rows = await db.select({ id: projects.id, name: projects.clientName }).from(projects).where(inArray(projects.id, ids));
  const map: Record<string, string> = {};
  for (const r of rows) map[r.id] = r.name;
  return map;
}

/** Projects for the admin picker. All projects for super_admin; one company's for a company_admin. */
export async function projectPickerList(companyId?: string | null) {
  const base = db.select({ id: projects.id, name: projects.clientName, url: projects.websiteUrl, companyId: projects.companyId })
    .from(projects).orderBy(desc(projects.updatedAt));
  return companyId ? await base.where(eq(projects.companyId, companyId)) : await base;
}
