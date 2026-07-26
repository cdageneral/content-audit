import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";
import NavActions from "@/components/NavActions";

export const metadata: Metadata = {
  title: "Prism Optimizer — LLM Content Readiness",
  description: "Prism Optimizer scores and optimizes your content for how AI systems retrieve, cite, and reuse it.",
  icons: { icon: "/icon.svg" },
  openGraph: {
    title: "Prism Optimizer — LLM Content Readiness",
    description: "Prism Optimizer scores and optimizes your content for how AI systems retrieve, cite, and reuse it.",
    images: ["/prism-optimizer-logo.png"],
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
                <path d="M4 66 L44 50" stroke="#c9a4fd" strokeWidth={7} strokeLinecap="round" />
                <path d="M56 46 L98 30" stroke="#ce9efc" strokeWidth={6} strokeLinecap="round" />
                <path d="M56 49 L98 44" stroke="#a56bfb" strokeWidth={6} strokeLinecap="round" />
                <path d="M56 52 L98 60" stroke="#6f1cfe" strokeWidth={6} strokeLinecap="round" />
                <path d="M50 14 L83 82 L17 82 Z" stroke="#0b0b24" strokeWidth={8} strokeLinejoin="round" strokeLinecap="round" />
              </svg>
              <div>
                <p className="text-sm font-semibold leading-none" style={{ color: "var(--text-1)" }}>
                  Prism Optimizer
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
