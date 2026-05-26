import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Content Audit Agent",
  description: "Score and optimize your content for LLM readiness",
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
              <div className="flex h-8 w-8 items-center justify-center rounded-lg flex-shrink-0"
                style={{ background: "linear-gradient(135deg, #6366f1 0%, #818cf8 100%)" }}>
                <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" stroke="white" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round"
                    d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold leading-none" style={{ color: "var(--text-1)" }}>
                  Content Audit Agent
                </p>
                <p className="text-xs leading-none mt-0.5" style={{ color: "var(--text-3)" }}>
                  LLM Readiness
                </p>
              </div>
            </Link>

            {/* Right side nav */}
            <div className="flex items-center gap-1">
              <Link href="/" className="px-3 py-1.5 rounded-lg text-sm transition-colors"
                style={{ color: "var(--text-2)" }}
                onMouseEnter={e => (e.currentTarget.style.color = "var(--text-1)")}
                onMouseLeave={e => (e.currentTarget.style.color = "var(--text-2)")}>
                Dashboard
              </Link>
              <Link href="/projects/new" className="btn-primary ml-2 text-sm px-4 py-1.5">
                + New Project
              </Link>
            </div>
          </div>
        </nav>

        <main>{children}</main>
      </body>
    </html>
  );
}
