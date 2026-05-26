import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createProject, listProjects } from "@/lib/db/projects";

const CreateSchema = z.object({
  clientName: z.string().min(1).max(120),
  websiteUrl: z.string().url(),
  scopePrefix: z.string().optional(),
  maxPages: z.number().int().min(1).max(5000).optional().default(100),
  authConfig: z.record(z.unknown()).optional(),
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
});

export async function GET() {
  try {
    const projects = await listProjects();
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
    const project = await createProject(projectData);

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
