import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createProject, listProjects } from "@/lib/db/projects";
import { authEnforced, seesAllProjects } from "@/lib/auth/config";
import { getActiveUser } from "@/lib/auth/session";
import { getGrantedProjectIds, getCompanyProjectIds, ensureAuthTables } from "@/lib/auth/store";

const CreateSchema = z
  .object({
    clientName: z.string().min(1).max(120),
    websiteUrl: z.string().url(),
    scopePrefix: z.string().optional(),
    maxPages: z.number().int().min(1).max(5000).optional().default(100),
    authConfig: z.record(z.unknown()).optional(),
    // How the client's URL set is built for a run.
    auditSource: z.enum(["domain", "single", "list"]).optional().default("domain"),
    // Explicit URL list — required (and only used) when auditSource === 'list'.
    sourceUrls: z.array(z.string().url()).max(5000).optional(),
    competitors: z
      .array(
        z.object({
          name: z.string().min(1),
          url: z.string().url(),
          scopePrefix: z.string().optional(),
        })
      )
      .optional()
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.auditSource === "list") {
      const urls = data.sourceUrls ?? [];
      if (urls.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["sourceUrls"],
          message: "Provide at least one URL for a URL-list audit.",
        });
      }
    }
  });

export async function GET() {
  try {
    const all = await listProjects();
    let projects = all;
    // Company-scoped visibility (no-op unless AUTH_ENFORCED). super_admin sees
    // all; company_admin/client_user see their company's projects (client_user
    // further narrowed to their grant set when they have one).
    if (authEnforced()) {
      const user = await getActiveUser();
      if (!user) {
        projects = [];
      } else if (!seesAllProjects(user.role)) {
        await ensureAuthTables();
        const companyIds = new Set(user.cid ? await getCompanyProjectIds(user.cid) : []);
        let allowed = all.filter((p) => companyIds.has(p.id));
        if (user.role === "client_user") {
          const grants = await getGrantedProjectIds(user.sub);
          if (grants.length) {
            const g = new Set(grants);
            allowed = allowed.filter((p) => g.has(p.id));
          }
        }
        projects = allowed;
      }
    }
    return NextResponse.json({ projects });
  } catch (err) {
    console.error("[api/projects GET]", err);
    return NextResponse.json({ error: "Failed to list projects" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const parsed = CreateSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", issues: parsed.error.issues },
        { status: 400 }
      );
    }

    const { competitors, ...projectData } = parsed.data;

    // For a URL-list audit, dedupe the URLs and use the first as the
    // project's identity URL if the caller didn't set a meaningful one.
    if (projectData.auditSource === "list" && projectData.sourceUrls?.length) {
      projectData.sourceUrls = Array.from(new Set(projectData.sourceUrls));
      if (!projectData.websiteUrl) {
        projectData.websiteUrl = projectData.sourceUrls[0];
      }
    }

    const project = await createProject(projectData);

    // Stamp the new project with the creator's company so it's visible to that
    // company right away (super_admin leaves it unassigned → assign on the
    // Admin → Companies tab). No-op unless AUTH_ENFORCED.
    if (authEnforced()) {
      const actor = await getActiveUser();
      if (actor?.cid) {
        const { db } = await import("@/db");
        const { projects: authProjects } = await import("@/db/schema");
        const { eq } = await import("drizzle-orm");
        await db.update(authProjects).set({ companyId: actor.cid }).where(eq(authProjects.id, project.id));
      }
    }

    // Add competitors if provided
    if (competitors.length > 0) {
      const { addCompetitor } = await import("@/lib/db/projects");
      await Promise.all(
        competitors.map((c) => addCompetitor(project.id, c))
      );
    }

    return NextResponse.json({ project }, { status: 201 });
  } catch (err) {
    console.error("[api/projects POST]", err);
    return NextResponse.json({ error: "Failed to create project" }, { status: 500 });
  }
}
