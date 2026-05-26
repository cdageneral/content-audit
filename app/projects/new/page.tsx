import CreateProjectForm from "@/components/CreateProjectForm";

export default function NewProjectPage() {
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
