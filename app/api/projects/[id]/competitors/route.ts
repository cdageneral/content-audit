import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addCompetitor, getCompetitorsByProject, deleteCompetitor } from "@/lib/db/projects";

type Params = { params: { id: string } };

const AddSchema = z.object({
  name: z.string().min(1).max(120),
  url: z.string().url(),
  scopePrefix: z.string().optional(),
});

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const competitors = await getCompetitorsByProject(params.id);
    return NextResponse.json({ competitors });
  } catch (err) {
    return NextResponse.json({ error: "Failed to list competitors" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const body = await req.json();
    const parsed = AddSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues }, { status: 400 });
    }
    const competitor = await addCompetitor(params.id, parsed.data);
    return NextResponse.json({ competitor }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: "Failed to add competitor" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const { competitorId } = await req.json();
    await deleteCompetitor(competitorId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: "Failed to delete competitor" }, { status: 500 });
  }
}
