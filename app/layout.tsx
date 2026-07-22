import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import NavActions from "@/components/NavActions";

export const metadata: Metadata = {
  title: "Meridian — LLM Content Readiness",
  description: "Meridian scores and optimizes your content for how AI systems retrieve, cite, and reuse it.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Meridian — LLM Content Readiness",
    description: "Meridian scores and optimizes your content for how AI systems retrieve, cite, and reuse it.",
    images: ["/meridian-logo.png"],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased" style={{ background: "var(--bg-0)", color: "var(--text-1)" }}>
        <nav className="app-nav">
          <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
            {/* Logo + wordmark */}
            <Link href="/" className="flex items-center gap-3" style={{ textDecoration: "none" }}>
              <svg viewBox="0 0 100 100" fill="none" className="h-8 w-8 flex-shrink-0" aria-hidden="true">
                <circle cx="50" cy="48" r="31" stroke="#14284a" strokeWidth={5} />
                <polygon points="50,20 55,48 45,48" fill="#2563eb" />
                <polygon points="45,48 55,48 50,76" fill="#14284a" />
                <circle cx="50" cy="48" r={4.5} fill="#ffffff" />
                <rect x="56" y="56" width="6" height="10" rx="1.5" fill="#7aa8e8" />
                <rect x="64" y="49" width="6" height="17" rx="1.5" fill="#4f8ae0" />
                <rect x="72" y="42" width="6" height="24" rx="1.5" fill="#2563eb" />
              </svg>
              <div>
                <p className="text-sm font-semibold leading-none" style={{ color: "var(--text-1)" }}>
                  Meridian
                </p>
                <p className="text-xs leading-none mt-0.5" style={{ color: "var(--text-3)" }}>
                  LLM Readiness
                </p>
              </div>
            </Link>

            {/* Right side nav */}
            <div className="flex items-center gap-1">
              <Link href="/" className="nav-link px-3 py-1.5 rounded-lg text-sm transition-colors">
                Dashboard
              </Link>
              {/* Route-aware actions (e.g. Download Assessment on a project page).
                  "New Project" lives on the dashboard, gated to super/company admins. */}
              <NavActions />
            </div>
          </div>
        </nav>

        <main>{children}</main>
      </body>
    </html>
  );
}
