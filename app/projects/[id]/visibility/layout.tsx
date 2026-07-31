// ─────────────────────────────────────────────────────────────
//  /projects/[id]/visibility — section layout (2026-07-31).
//  The section was renamed "AI Visibility" → "Visibility" and now
//  tells one story across two channels via tabs:
//    · AI Answers        (the original surface, unchanged)
//    · Google Rankings   (organic positions from stored snapshots)
//    · Combined          (rank × AI-citation quadrants)
//  Access gating happens in the project layout above; per-tab
//  pages keep their own gate for direct-hit safety, matching the
//  sibling routes.
// ─────────────────────────────────────────────────────────────

import VisibilityTabs from "@/components/VisibilityTabs";

export default function VisibilityLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: { id: string };
}) {
  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      <div className="anim-fade-up relative z-30">
        <h1 className="text-2xl font-bold" style={{ color: "var(--text-1)", letterSpacing: "-0.02em" }}>
          Visibility
        </h1>
        <p className="text-sm mt-1" style={{ color: "var(--text-3)" }}>
          One story, two channels — how your content shows up in AI answers, and where it ranks in
          Google. Same scans, same keywords, side by side.
        </p>
      </div>
      <VisibilityTabs projectId={params.id} />
      {children}
    </div>
  );
}
