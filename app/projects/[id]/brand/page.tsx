// ─────────────────────────────────────────────────────────────
//  /projects/[id]/brand — Brand & Context (Setup).
//  Upload brand guidelines / company info once; every AI-written
//  draft and packet in this project is generated against the
//  approved profile. Server component: loads profile + sources,
//  hands everything to the client view.
// ─────────────────────────────────────────────────────────────

import { notFound, redirect } from "next/navigation";
import { checkProjectAccess } from "@/lib/auth/access";
import { getProject } from "@/lib/db/projects";
import { getBrandProfile, listBrandSources } from "@/lib/brand/store";
import BrandContextView from "@/components/BrandContextView";

export const revalidate = 0;

export default async function BrandContextPage({
  params,
}: {
  params: { id: string };
}) {
  const gate = await checkProjectAccess(params.id);
  if (!gate.ok) redirect("/");
  const project = await getProject(params.id).catch(() => null);
  if (!project) return notFound();

  const [stored, sources] = await Promise.all([
    getBrandProfile(params.id).catch(() => null),
    listBrandSources(params.id).catch(() => []),
  ]);

  return (
    <BrandContextView
      projectId={params.id}
      projectName={project.clientName}
      initialProfile={stored?.profile ?? null}
      initialUpdatedAt={stored?.updatedAt ?? null}
      initialSources={sources}
    />
  );
}
