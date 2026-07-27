'use client';

/**
 * NavActions — right-side action(s) in the global top nav that depend on the
 * current route.
 *
 * Since the left-rail app shell (2026-07-27), project-scoped actions live
 * INSIDE the project sections: competitor management on /competitors and
 * /settings, the assessment download on the Overview header and /reports.
 * The top nav stays global-only, so this component currently renders nothing —
 * it's kept (rather than deleted) as the mount point for future global
 * actions, and so app/layout.tsx keeps a stable shape.
 */

export default function NavActions() {
  return null;
}
