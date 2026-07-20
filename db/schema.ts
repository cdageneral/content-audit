/**
 * db/schema.ts — multi-tenant auth tables for the Content Audit app.
 *
 * Adapted from the auth-starter-kit (single-tenant) into a COMPANY-scoped model:
 *
 *   companies ──< app_users            (each user belongs to one company;
 *                                        super_admin has company_id = null)
 *   companies ──< projects.company_id  (each project belongs to one company)
 *   app_users ──< project_access       (OPTIONAL per-user restriction inside a
 *                                        company — see access.ts for the
 *                                        "all-by-default, can-restrict" rule)
 *
 * Roles (3 tiers, replacing the kit's owner/admin/editor/viewer):
 *   super_admin   — you. Creates companies, sets seat limits + expiry, assigns
 *                   projects to companies, manages everyone. Sees every project.
 *   company_admin — delegated. Adds/removes users inside THEIR company up to the
 *                   seat cap, sets per-user expiry. Sees only their company.
 *   client_user   — end client. Sees only their company's projects (all by
 *                   default, or a restricted subset if grants exist).
 *
 * NOTE ON THE `projects` TABLE: the Content Audit app already owns and manages
 * `projects` via raw SQL (lib/db/projects.ts). We do NOT recreate it here — the
 * Drizzle definition below is a READ MODEL that mirrors only the columns the auth
 * layer touches, plus the company_id we add. Table creation for projects stays
 * in the app; ensureAuthTables() only ALTERs it to add company_id.
 */

import { pgTable, text, integer, timestamp, uuid, jsonb, pgEnum } from 'drizzle-orm/pg-core';

// ─── Companies (the tenant) ──────────────────────────────────────────────────

export const companies = pgTable('companies', {
  id:        uuid('id').defaultRandom().primaryKey(),
  name:      text('name').notNull(),
  // How many users this company may have (active + pending count against it).
  seatLimit: integer('seat_limit').notNull().default(1),
  // Company-wide access expiry. null = never expires. Enforced at login and on
  // every privileged request; a user is also blocked by their OWN expires_at.
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Resource being gated (READ MODEL of the app's real projects table) ──────
// Only the columns the auth layer reads, plus company_id. Never full-selected.

export const projects = pgTable('projects', {
  id:         uuid('id').defaultRandom().primaryKey(),
  clientName: text('client_name').notNull(),
  websiteUrl: text('website_url').notNull().default(''),
  companyId:  uuid('company_id').references(() => companies.id, { onDelete: 'set null' }),
  updatedAt:  timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─── Auth ────────────────────────────────────────────────────────────────────

export const userRoleEnum   = pgEnum('user_role',   ['super_admin', 'company_admin', 'client_user']);
export const userStatusEnum  = pgEnum('user_status', ['active', 'pending', 'suspended']);

export const appUsers = pgTable('app_users', {
  id:           uuid('id').defaultRandom().primaryKey(),
  email:        text('email').notNull().unique(),
  name:         text('name').notNull(),
  // null while a user is invited-but-has-not-set-a-password (status 'pending')
  passwordHash: text('password_hash'),
  role:         userRoleEnum('role').notNull().default('client_user'),
  status:       userStatusEnum('status').notNull().default('active'),
  // null only for super_admin; company_admin / client_user always belong to one.
  companyId:    uuid('company_id').references(() => companies.id, { onDelete: 'cascade' }),
  // Per-user access expiry. null = falls back to the company's expires_at.
  expiresAt:    timestamp('expires_at', { withTimezone: true }),
  createdAt:    timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastLoginAt:  timestamp('last_login_at', { withTimezone: true }),
});

// OPTIONAL per-project restriction inside a company. When a client_user has ZERO
// grant rows they see ALL of their company's projects (default). When they have
// one or more, they are restricted to exactly those. company_admin / super_admin
// ignore this table.
export const projectAccess = pgTable('project_access', {
  id:        uuid('id').defaultRandom().primaryKey(),
  userId:    uuid('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const authSessions = pgTable('auth_sessions', {
  id:        uuid('id').defaultRandom().primaryKey(),
  userId:    uuid('user_id').notNull().references(() => appUsers.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ip:        text('ip'),
  userAgent: text('user_agent'),
});

export const auditEvents = pgTable('audit_events', {
  id:          uuid('id').defaultRandom().primaryKey(),
  actorUserId: uuid('actor_user_id'),
  actorEmail:  text('actor_email'),
  actorName:   text('actor_name'),
  // Denormalized company so the log can be scoped per-company without a join.
  companyId:   uuid('company_id'),
  action:      text('action').notNull(),
  projectId:   uuid('project_id'),
  projectName: text('project_name'),
  meta:        jsonb('meta').$type<Record<string, unknown>>(),
  ip:          text('ip'),
  userAgent:   text('user_agent'),
  createdAt:   timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export type Company       = typeof companies.$inferSelect;
export type AppUser       = typeof appUsers.$inferSelect;
export type NewAppUser    = typeof appUsers.$inferInsert;
export type ProjectAccess = typeof projectAccess.$inferSelect;
export type AuthSession   = typeof authSessions.$inferSelect;
export type AuditEvent    = typeof auditEvents.$inferSelect;
export type NewAuditEvent = typeof auditEvents.$inferInsert;
