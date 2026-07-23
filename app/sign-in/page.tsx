'use client';

/**
 * /sign-in — email + password login, with first-run super_admin bootstrap.
 *
 * Self-contained styling (standard Tailwind utilities only — no custom design
 * tokens) so it drops into any app. Rename BRAND below to your product name.
 *
 * On mount it calls /api/auth/me: already signed in → go to ?next (default '/');
 * no users yet → show the "create the first admin" form; otherwise login.
 */

import { useEffect, useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

const BRAND = 'Meridian';

type Mode = 'loading' | 'login' | 'bootstrap';

export default function SignInPage() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
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
  const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition';
  const label = 'block text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-1.5';

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-2 mb-8">
          <svg viewBox="0 0 100 100" fill="none" className="w-6 h-6" aria-hidden="true">
            <circle cx="50" cy="48" r="31" stroke="#14284a" strokeWidth={5} />
            <polygon points="50,20 55,48 45,48" fill="#7c3aed" />
            <polygon points="45,48 55,48 50,76" fill="#14284a" />
            <circle cx="50" cy="48" r={4.5} fill="#ffffff" />
            <rect x="56" y="56" width="6" height="10" rx="1.5" fill="#c4b5fd" />
            <rect x="64" y="49" width="6" height="17" rx="1.5" fill="#a78bfa" />
            <rect x="72" y="42" width="6" height="24" rx="1.5" fill="#7c3aed" />
          </svg>
          <span className="text-lg font-bold text-slate-900">{BRAND}</span>
        </div>

        {mode === 'loading' ? (
          <div className="space-y-3">
            <div className="h-6 w-32 bg-slate-200 rounded animate-pulse" />
            <div className="h-11 bg-slate-200 rounded-lg animate-pulse" />
            <div className="h-11 bg-slate-200 rounded-lg animate-pulse" />
          </div>
        ) : (
          <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-xl font-bold text-slate-900">{isBootstrap ? 'Create your admin account' : 'Sign in'}</h1>
            <p className="text-slate-500 text-[13px] mt-1 mb-6">
              {isBootstrap
                ? 'First run — set up the super-admin account that manages companies and users.'
                : 'Welcome back. Enter your credentials.'}
            </p>

            {isBootstrap && (
              <label className="block mb-4">
                <span className={label}>Full name</span>
                <input value={name} onChange={e => setName(e.target.value)} required autoComplete="name"
                  placeholder="Wayne Cichanski" className={input} />
              </label>
            )}

            <label className="block mb-4">
              <span className={label}>Email</span>
              <input type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email"
                placeholder="you@company.com" className={input} />
            </label>

            <label className="block">
              <span className={label}>Password</span>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} required
                autoComplete={isBootstrap ? 'new-password' : 'current-password'}
                placeholder={isBootstrap ? 'At least 8 characters' : '••••••••••'} className={input} />
            </label>

            {error && (
              <div className="mt-4 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>
            )}

            <button type="submit" disabled={busy}
              className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold text-sm rounded-lg py-3 transition-colors">
              {busy ? 'Please wait…' : isBootstrap ? 'Create account →' : 'Sign in →'}
            </button>

            {!isBootstrap && (
              <p className="text-[11px] text-slate-400 mt-5">
                Accounts are created by an administrator — there is no open sign-up.
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
}
