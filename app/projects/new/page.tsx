import { redirect } from "next/navigation";
import CreateProjectForm from "@/components/CreateProjectForm";
import { checkAdmin } from "@/lib/auth/access";

export default async function NewProjectPage() {
  // Only super admins and company admins may create projects (no-op when the
  // wall is off). Anyone else is sent back to their dashboard.
  const gate = await checkAdmin();
  if (!gate.ok) redirect("/");
  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <div className="anim-fade-up mb-8">
        <p className="text-xs font-semibold uppercase tracking-widest mb-2" style={{ color: "var(--indigo)" }}>
          New Project
        </p>
        <h1 className="text-3xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Set up your audit
        </h1>
        <p className="mt-2" style={{ color: "var(--text-2)" }}>
          Configure the client site and add competitors to start tracking LLM readiness.
        </p>
      </div>
      <CreateProjectForm />
    </div>
  );
}
