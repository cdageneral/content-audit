'use client';

/**
 * /sign-in — email + password login, with first-run super_admin bootstrap.
 *
 * Split layout: brand panel left (hidden under lg), form right. Styled with the
 * app's own design tokens from globals.css (--bg-*, --text-*, --indigo) and the
 * shared .dark-input / .btn-primary classes, so it matches the dashboard the
 * user lands on. The wordmark lives in the app nav above this page, so the only
 * brand art here is the hero logo on the left panel — no duplicate lockup.
 *
 * On mount it calls /api/auth/me: already signed in → go to ?next (default '/');
 * no users yet → show the "create the first admin" form; otherwise login.
 */

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BRAND = 'Prism Optimizer';

const BULLETS = [
  'Scored on 10 dimensions of how an LLM retrieves, cites, and reuses your page',
  'Simulate the new score before you publish',
  'Every page gets a rewrite packet, not just a grade',
  'Side-by-side against the competitors actually winning the answer',
  'Monitor competitors’ content publishing velocity',
];

type Mode = 'loading' | 'login' | 'bootstrap';

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}

function Tick() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"
      className="w-[15px] h-[15px] flex-shrink-0 mt-[2px]">
      <circle cx="12" cy="12" r="10" fill="rgba(99,102,241,0.12)" />
      <path d="M8 12.4l2.6 2.6L16 9.6" stroke="var(--indigo)" strokeWidth={2.4}
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const nextPath = params.get('next') || '/';

  const [mode, setMode]         = useState<Mode>('loading');
  const [name, setName]         = useState('');
  const [email, setEmail]       = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/me', { cache: 'no-store' });
        const data = await res.json();
        if (!alive) return;
        if (data.user) { router.replace(nextPath); return; }
        setMode(data.needsBootstrap ? 'bootstrap' : 'login');
      } catch {
        if (alive) setMode('login');
      }
    })();
    return () => { alive = false; };
  }, [router, nextPath]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const url  = mode === 'bootstrap' ? '/api/auth/bootstrap' : '/api/auth/login';
      const body = mode === 'bootstrap' ? { name, email, password } : { email, password };
      const res  = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setError(data.error || 'Something went wrong. Please try again.'); setBusy(false); return; }
      router.replace(nextPath);
    } catch {
      setError('Network error. Please try again.');
      setBusy(false);
    }
  }

  const isBootstrap = mode === 'bootstrap';
  const label = 'block text-[11px] font-medium uppercase tracking-wider mb-1.5';

  return (
    // 65px = app-nav height, so the split fills the viewport without adding a scrollbar.
    <div className="flex min-h-[calc(100vh-65px)]" style={{ background: 'var(--bg-0)' }}>

      {/* ── Brand panel (desktop only; the app nav carries the wordmark on mobile) ── */}
      <div
        className="hidden lg:flex lg:w-[54%] flex-col justify-center px-14 py-16 relative overflow-hidden"
        style={{
          borderRight: '1px solid var(--border)',
          background:
            'radial-gradient(760px 460px at 12% 8%, rgba(139,92,246,0.13), transparent 62%),' +
            'radial-gradient(620px 520px at 92% 96%, rgba(99,102,241,0.11), transparent 58%),' +
            'var(--bg-0)',
        }}
      >
        <h2 className="text-[39px] font-extrabold leading-[1.08] tracking-[-0.03em] max-w-[470px]"
          style={{ color: 'var(--text-1)' }}>
          Get cited{' '}
          <span style={{
            background: 'linear-gradient(96deg, #6f1cfe, #a56bfb 55%, #c9a4fd)',
            WebkitBackgroundClip: 'text',
            backgroundClip: 'text',
            color: 'transparent',
          }}>by AI.</span>
        </h2>

        <p className="mt-4 max-w-[440px] text-[15px] leading-relaxed" style={{ color: 'var(--text-2)' }}>
          {BRAND} audits your site the way an LLM reads it, scores every page on how findable
          and quotable it is, and shows you where you&rsquo;re losing to competitors in AI answers.
        </p>

        <ul className="mt-6 flex flex-col gap-2.5 max-w-[445px]">
          {BULLETS.map((t) => (
            <li key={t} className="flex items-start gap-3">
              <Tick />
              <span className="text-[13.5px] leading-[1.5]" style={{ color: 'var(--text-2)' }}>{t}</span>
            </li>
          ))}
        </ul>

        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/prism-optimizer-logo-hero.png"
          alt={BRAND}
          className="block w-full max-w-[440px] h-auto mt-8"
        />
      </div>

      {/* ── Form panel ── */}
      <div className="flex-1 flex items-center justify-center px-6 py-12">
        <div className="w-full max-w-sm">
          {mode === 'loading' ? (
            <div className="space-y-3">
              <div className="h-6 w-32 rounded animate-pulse" style={{ background: 'var(--bg-3)' }} />
              <div className="h-11 rounded-lg animate-pulse" style={{ background: 'var(--bg-3)' }} />
              <div className="h-11 rounded-lg animate-pulse" style={{ background: 'var(--bg-3)' }} />
            </div>
          ) : (
            <form onSubmit={submit} className="rounded-2xl p-6"
              style={{
                background: 'var(--bg-1)',
                border: '1px solid var(--border)',
                boxShadow: '0 1px 2px rgba(15,23,42,0.05)',
              }}>
              <h1 className="text-xl font-bold" style={{ color: 'var(--text-1)' }}>
                {isBootstrap ? 'Create your admin account' : 'Sign in'}
              </h1>
              <p className="text-[13px] mt-1 mb-6" style={{ color: 'var(--text-3)' }}>
                {isBootstrap
                  ? 'First run — set up the super-admin account that manages companies and users.'
                  : 'Welcome back. Enter your credentials.'}
              </p>

              {isBootstrap && (
                <label className="block mb-4">
                  <span className={label} style={{ color: 'var(--text-3)' }}>Full name</span>
                  <input value={name} onChange={e => setName(e.target.value)} required autoComplete="name"
                    placeholder="Wayne Cichanski" className="dark-input" />
                </label>
              )}

              <label className="block mb-4">
                <span className={label} style={{ color: 'var(--text-3)' }}>Email</span>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email"
                  placeholder="you@company.com" className="dark-input" />
              </label>

              <label className="block">
                <span className={label} style={{ color: 'var(--text-3)' }}>Password</span>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                  autoComplete={isBootstrap ? 'new-password' : 'current-password'}
                  placeholder={isBootstrap ? 'At least 8 characters' : '••••••••••'} className="dark-input" />
              </label>

              {error && (
                <div className="mt-4 text-[13px] rounded-lg px-3 py-2"
                  style={{ color: 'var(--red)', background: 'rgba(220,38,38,0.08)', border: '1px solid rgba(220,38,38,0.25)' }}>
                  {error}
                </div>
              )}

              <button type="submit" disabled={busy} className="btn-primary w-full mt-6 font-semibold py-3">
                {busy ? 'Please wait…' : isBootstrap ? 'Create account →' : 'Sign in →'}
              </button>

              {!isBootstrap && (
                <p className="text-[11px] mt-5" style={{ color: 'var(--text-3)' }}>
                  Accounts are created by an administrator — there is no open sign-up.
                </p>
              )}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
