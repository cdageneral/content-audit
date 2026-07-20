'use client';

/**
 * /account — self-service change password (for users given a temp password).
 * Self-contained styling (standard Tailwind only).
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function AccountPage() {
  const router = useRouter();
  const [me, setMe] = useState<{ name: string; email: string; role: string } | null>(null);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    (async () => {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      if (!data.user) { router.replace('/sign-in?next=/account'); return; }
      setMe(data.user);
    })();
  }, [router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (next !== confirm) { setMsg({ ok: false, text: 'New passwords do not match.' }); return; }
    setBusy(true);
    const res = await fetch('/api/auth/change-password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: current, newPassword: next }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg({ ok: false, text: data.error || 'Could not change password.' }); return; }
    setMsg({ ok: true, text: 'Password changed.' });
    setCurrent(''); setNext(''); setConfirm('');
  }

  const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition';
  const label = 'block text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-1.5';

  return (
    <div className="min-h-screen bg-slate-50 px-6 py-12">
      <div className="max-w-md mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-slate-900">Your account</h1>
          <a href="/" className="text-sm text-indigo-600 hover:underline">← Back</a>
        </div>
        {me && (
          <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5 text-sm">
            <div className="font-semibold text-slate-900">{me.name}</div>
            <div className="text-slate-500 text-[13px]">{me.email}</div>
          </div>
        )}
        <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-900 mb-4">Change password</h2>
          <label className="block mb-4"><span className={label}>Current password</span>
            <input type="password" value={current} onChange={e => setCurrent(e.target.value)} required className={input} /></label>
          <label className="block mb-4"><span className={label}>New password</span>
            <input type="password" value={next} onChange={e => setNext(e.target.value)} required placeholder="At least 8 characters" className={input} /></label>
          <label className="block"><span className={label}>Confirm new password</span>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required className={input} /></label>
          {msg && (
            <div className={`mt-4 text-[13px] rounded-lg px-3 py-2 border ${msg.ok ? 'text-green-700 bg-green-50 border-green-200' : 'text-red-700 bg-red-50 border-red-200'}`}>{msg.text}</div>
          )}
          <button type="submit" disabled={busy}
            className="w-full mt-6 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-60 text-white font-semibold text-sm rounded-lg py-3 transition-colors">
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
