'use client';

/**
 * /admin — company-aware admin panel. Self-contained styling (standard Tailwind).
 *
 *  super_admin  : Companies (create, seats, expiry, assign projects) + Users
 *                 (across all companies) + Activity (everything).
 *  company_admin: Users (client users in their own company, up to the seat cap,
 *                 with per-user expiry + optional project restriction) + Activity
 *                 (their company only).
 *
 * Every list is a real DB read with an honest empty state.
 */

import { useEffect, useState, useCallback, Fragment } from 'react';

const BRAND = 'Meridian';

type Role = 'super_admin' | 'company_admin' | 'client_user';
type Status = 'active' | 'pending' | 'suspended';

interface AdminUser {
  id: string; name: string; email: string; role: Role; status: Status;
  companyId: string | null; expiresAt: string | null;
  createdAt: string; lastLoginAt: string | null; projectIds: string[];
}
interface Proj { id: string; name: string; url: string; companyId: string | null }
interface Company {
  id: string; name: string; seatLimit: number; expiresAt: string | null;
  createdAt: string; seatsUsed: number; projectCount: number;
}
interface Me { role: Role; companyId: string | null }

type Tab = 'companies' | 'users' | 'add' | 'activity';

/* ── helpers ─────────────────────────────────────────────────────────────── */
function timeAgo(iso: string | null): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 172800) return 'yesterday';
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDate(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
function toDateInput(iso: string | null): string { return iso ? iso.slice(0, 10) : ''; }
function isExpired(iso: string | null): boolean { return !!iso && new Date(iso).getTime() <= Date.now(); }

const roleLabel: Record<Role, string> = { super_admin: 'Super admin', company_admin: 'Company admin', client_user: 'Client user' };

const btn = 'text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-60';
const btnPrimary = `${btn} bg-indigo-600 hover:bg-indigo-700 text-white`;
const btnGhost = `${btn} border border-slate-300 text-slate-600 hover:text-slate-900 hover:border-slate-400`;
const input = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 transition';
const labelCls = 'block text-[11px] font-medium uppercase tracking-wider text-slate-500 mb-1.5';

function RoleBadge({ role }: { role: Role }) {
  const map: Record<Role, string> = {
    super_admin: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    company_admin: 'bg-amber-50 text-amber-700 border-amber-200',
    client_user: 'bg-slate-100 text-slate-600 border-slate-200',
  };
  return <span className={`text-[10px] font-medium px-2 py-0.5 rounded border ${map[role]}`}>{roleLabel[role]}</span>;
}
function StatusDot({ status }: { status: Status }) {
  const color = status === 'active' ? 'bg-green-500' : status === 'pending' ? 'bg-amber-500' : 'bg-slate-400';
  return <span className="inline-flex items-center gap-1.5 text-[12px] text-slate-600"><span className={`w-1.5 h-1.5 rounded-full ${color}`} />{status[0].toUpperCase() + status.slice(1)}</span>;
}

/* ── page ────────────────────────────────────────────────────────────────── */
export default function AdminPage() {
  const [me, setMe]           = useState<Me | null>(null);
  const [tab, setTab]         = useState<Tab>('users');
  const [users, setUsers]     = useState<AdminUser[]>([]);
  const [projects, setProjects] = useState<Proj[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [denied, setDenied]   = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetch('/api/admin/users', { cache: 'no-store' });
    if (res.status === 401 || res.status === 403) { setDenied(true); setLoading(false); return; }
    const data = await res.json().catch(() => ({ users: [], projects: [] }));
    setUsers(data.users ?? []);
    setProjects(data.projects ?? []);
    setCompanies(data.companies ?? []);
    setMe(data.me ?? null);
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const isSuper = me?.role === 'super_admin';
  const companyName = (id: string | null) => companies.find(c => c.id === id)?.name ?? (id ? '—' : 'Internal');
  const projName = (id: string) => projects.find(p => p.id === id)?.name ?? 'project';

  async function signOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/sign-in';
  }

  const tabs: [Tab, string][] = isSuper
    ? [['companies', 'Companies'], ['users', 'Users'], ['add', 'Add User'], ['activity', 'Activity']]
    : [['users', 'Users'], ['add', 'Add User'], ['activity', 'Activity']];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <svg viewBox="0 0 100 100" fill="none" className="w-6 h-6" aria-hidden="true">
              <circle cx="50" cy="48" r="31" stroke="#14284a" strokeWidth={5} />
              <polygon points="50,20 55,48 45,48" fill="#7c3aed" />
              <polygon points="45,48 55,48 50,76" fill="#14284a" />
              <circle cx="50" cy="48" r={4.5} fill="#ffffff" />
              <rect x="56" y="56" width="6" height="10" rx="1.5" fill="#c4b5fd" />
              <rect x="64" y="49" width="6" height="17" rx="1.5" fill="#a78bfa" />
              <rect x="72" y="42" width="6" height="24" rx="1.5" fill="#7c3aed" />
            </svg>
            <span className="text-lg font-bold">{BRAND}</span>
            <span className="text-[10px] uppercase tracking-wider text-slate-400 border border-slate-200 rounded px-2 py-0.5">Admin</span>
          </div>
          <div className="flex items-center gap-3">
            <a href="/" className={btnGhost}>Projects</a>
            <a href="/account" className={btnGhost}>Account</a>
            <button onClick={signOut} className={btnGhost}>Sign out</button>
          </div>
        </div>
      </nav>

      {denied ? (
        <div className="max-w-md mx-auto text-center py-24 px-6">
          <h2 className="text-lg font-semibold">Admins only</h2>
          <p className="text-slate-500 text-sm mt-1">You need an admin account to manage users.</p>
          <a href="/" className="inline-block mt-5 text-sm text-indigo-600 hover:underline">← Back to projects</a>
        </div>
      ) : (
        <div className="max-w-6xl mx-auto px-6 py-8">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold">Users &amp; Access</h1>
            <p className="text-slate-500 text-sm mt-1">
              {isSuper
                ? 'Create companies, set seats and expiry, assign projects, and manage everyone.'
                : 'Add people to your company up to your seat limit, set expiry, and see recent activity.'}
            </p>
          </div>

          <div className="flex gap-1 border-b border-slate-200 mb-6">
            {tabs.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)}
                className={`text-[13px] px-4 py-2.5 border-b-2 -mb-px transition-colors ${tab === k ? 'text-indigo-600 border-indigo-600 font-medium' : 'text-slate-500 border-transparent hover:text-slate-900'}`}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'companies' && isSuper && <CompaniesTab companies={companies} projects={projects} reload={load} />}
          {tab === 'users'    && <UsersTab loading={loading} users={users} projects={projects} isSuper={isSuper} companyName={companyName} projName={projName} companies={companies} reload={load} />}
          {tab === 'add'      && <AddUserTab isSuper={isSuper} companies={companies} projects={projects} onDone={() => { setTab('users'); load(); }} />}
          {tab === 'activity' && <ActivityTab />}
        </div>
      )}
    </div>
  );
}

/* ── Companies tab (super_admin) ─────────────────────────────────────────── */
function CompaniesTab({ companies, projects, reload }: { companies: Company[]; projects: Proj[]; reload: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  return (
    <div>
      <div className="flex justify-between items-center mb-4">
        <p className="text-sm text-slate-500">{companies.length} compan{companies.length === 1 ? 'y' : 'ies'}</p>
        <button className={btnPrimary} onClick={() => setShowNew(v => !v)}>{showNew ? 'Cancel' : '+ New company'}</button>
      </div>

      {showNew && <NewCompanyForm onDone={() => { setShowNew(false); reload(); }} />}

      {companies.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white text-center py-16 text-sm text-slate-500">
          No companies yet. Create one, then add its users on the Users tab.
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <table className="w-full text-[13px]">
            <thead><tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
              {['Company', 'Seats', 'Expiry', 'Projects', ''].map((h, i) => <th key={i} className="px-4 py-3 border-b border-slate-200 font-medium">{h}</th>)}
            </tr></thead>
            <tbody>
              {companies.map(c => (
                <Fragment key={c.id}>
                  <tr className="hover:bg-slate-50">
                    <td className="px-4 py-3 border-b border-slate-100 font-semibold">{c.name}</td>
                    <td className="px-4 py-3 border-b border-slate-100">
                      <span className={c.seatsUsed >= c.seatLimit ? 'text-amber-600 font-medium' : ''}>{c.seatsUsed} / {c.seatLimit}</span>
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100">
                      <span className={isExpired(c.expiresAt) ? 'text-red-600 font-medium' : 'text-slate-600'}>{fmtDate(c.expiresAt)}{isExpired(c.expiresAt) ? ' (expired)' : ''}</span>
                    </td>
                    <td className="px-4 py-3 border-b border-slate-100 text-slate-600">{c.projectCount}</td>
                    <td className="px-4 py-3 border-b border-slate-100 text-right">
                      <button onClick={() => setOpenId(openId === c.id ? null : c.id)} className="text-[12px] text-indigo-600 hover:underline">{openId === c.id ? 'Close' : 'Manage'}</button>
                    </td>
                  </tr>
                  {openId === c.id && (
                    <tr><td colSpan={5} className="bg-slate-50 border-b border-slate-200 px-4 py-4">
                      <ManageCompany company={c} projects={projects} reload={reload} onClose={() => setOpenId(null)} />
                    </td></tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function NewCompanyForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [seats, setSeats] = useState('3');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErr(null); setBusy(true);
    const res = await fetch('/api/admin/companies', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, seatLimit: Number(seats), expiresAt: expiry || null }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(data.error || 'Could not create company'); return; }
    onDone();
  }
  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white p-5 mb-4 grid sm:grid-cols-3 gap-4 items-end">
      <label className="block sm:col-span-1"><span className={labelCls}>Company name</span>
        <input value={name} onChange={e => setName(e.target.value)} required placeholder="Acme Inc." className={input} /></label>
      <label className="block"><span className={labelCls}>Seats (max users)</span>
        <input type="number" min={1} value={seats} onChange={e => setSeats(e.target.value)} required className={input} /></label>
      <label className="block"><span className={labelCls}>Access expires (optional)</span>
        <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={input} /></label>
      {err && <div className="sm:col-span-3 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{err}</div>}
      <div className="sm:col-span-3"><button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Creating…' : 'Create company'}</button></div>
    </form>
  );
}

function ManageCompany({ company, projects, reload, onClose }: { company: Company; projects: Proj[]; reload: () => void; onClose: () => void }) {
  const [name, setName] = useState(company.name);
  const [seats, setSeats] = useState(String(company.seatLimit));
  const [expiry, setExpiry] = useState(toDateInput(company.expiresAt));
  const [assigned, setAssigned] = useState<string[]>(projects.filter(p => p.companyId === company.id).map(p => p.id));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = (id: string) => setAssigned(a => a.includes(id) ? a.filter(x => x !== id) : [...a, id]);

  async function save() {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/admin/companies/${company.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, seatLimit: Number(seats), expiresAt: expiry || null, projectIds: assigned }),
    });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg(data.error || 'Update failed'); return; }
    setMsg('Saved'); reload();
  }
  async function remove() {
    if (!confirm(`Delete ${company.name}? Its users are removed and its projects become unassigned.`)) return;
    const res = await fetch(`/api/admin/companies/${company.id}`, { method: 'DELETE' });
    if (res.ok) { onClose(); reload(); } else { const d = await res.json().catch(() => ({})); setMsg(d.error || 'Delete failed'); }
  }
  // A project is selectable if unassigned or already this company's.
  const selectable = projects.filter(p => !p.companyId || p.companyId === company.id);

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <h4 className="text-[10px] uppercase tracking-wider text-slate-400 mb-3">Company settings</h4>
        <label className="block mb-3"><span className={labelCls}>Name</span><input value={name} onChange={e => setName(e.target.value)} className={input} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className={labelCls}>Seats</span><input type="number" min={1} value={seats} onChange={e => setSeats(e.target.value)} className={input} /></label>
          <label className="block"><span className={labelCls}>Expiry</span><input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={input} /></label>
        </div>
        <p className="text-[11px] text-slate-400 mt-1">Currently using {company.seatsUsed} of {company.seatLimit} seats. Leave expiry blank for never.</p>
        <div className="flex gap-2 mt-4">
          <button disabled={busy} onClick={save} className={btnPrimary}>Save</button>
          <button disabled={busy} onClick={remove} className={`${btn} border border-red-300 text-red-600 hover:bg-red-50`}>Delete</button>
        </div>
        {msg && <p className="text-[12px] text-slate-500 mt-3">{msg}</p>}
      </div>
      <div>
        <h4 className="text-[10px] uppercase tracking-wider text-slate-400 mb-3">Projects in this company — {assigned.length}</h4>
        {selectable.length === 0 ? <p className="text-[12px] text-slate-400">No unassigned projects available.</p> : (
          <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
            {selectable.map(p => {
              const on = assigned.includes(p.id);
              return (
                <button key={p.id} onClick={() => toggle(p.id)} className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-white text-left">
                  <span className={`w-8 h-5 rounded-full relative flex-shrink-0 transition-colors ${on ? 'bg-green-500' : 'bg-slate-300'}`}>
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} /></span>
                  <span className={`text-[12.5px] ${on ? 'text-slate-900' : 'text-slate-500'}`}>{p.name}</span>
                </button>
              );
            })}
          </div>
        )}
        <p className="text-[11px] text-slate-400 mt-2">Assigning a project moves it to this company. Remember to Save.</p>
      </div>
    </div>
  );
}

/* ── Users tab ───────────────────────────────────────────────────────────── */
function UsersTab({ loading, users, projects, isSuper, companyName, projName, companies, reload }:
  { loading: boolean; users: AdminUser[]; projects: Proj[]; isSuper: boolean; companyName: (id: string | null) => string; projName: (id: string) => string; companies: Company[]; reload: () => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (loading) return <div className="space-y-2">{[...Array(4)].map((_, i) => <div key={i} className="h-14 bg-white border border-slate-200 rounded-lg animate-pulse" />)}</div>;
  if (!users.length) return <div className="rounded-xl border border-slate-200 bg-white text-center py-16 text-sm text-slate-500">No users yet. Add your first on the Add User tab.</div>;

  const cols = isSuper ? ['User', 'Company', 'Role', 'Access', 'Expiry', 'Last login', 'Status', ''] : ['User', 'Role', 'Access', 'Expiry', 'Last login', 'Status', ''];
  return (
    <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
      <table className="w-full text-[13px]">
        <thead><tr className="text-left text-[10px] uppercase tracking-wider text-slate-400">
          {cols.map((h, i) => <th key={i} className="px-4 py-3 border-b border-slate-200 font-medium">{h}</th>)}
        </tr></thead>
        <tbody>
          {users.map(u => {
            const initials = u.name.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase();
            const access = u.role !== 'client_user' ? 'All company' : u.projectIds.length ? `${u.projectIds.length} project${u.projectIds.length === 1 ? '' : 's'}` : 'All company';
            return (
              <Fragment key={u.id}>
                <tr className="hover:bg-slate-50">
                  <td className="px-4 py-3 border-b border-slate-100">
                    <div className="flex items-center gap-3">
                      <span className="w-8 h-8 rounded-full bg-indigo-100 text-indigo-700 text-[11px] font-bold flex items-center justify-center">{initials}</span>
                      <div><div className="font-semibold">{u.name}</div><div className="text-[10px] text-slate-400">{u.email}</div></div>
                    </div>
                  </td>
                  {isSuper && <td className="px-4 py-3 border-b border-slate-100 text-slate-600">{companyName(u.companyId)}</td>}
                  <td className="px-4 py-3 border-b border-slate-100"><RoleBadge role={u.role} /></td>
                  <td className="px-4 py-3 border-b border-slate-100 text-[12px] text-slate-600">{access}</td>
                  <td className="px-4 py-3 border-b border-slate-100 text-[12px]"><span className={isExpired(u.expiresAt) ? 'text-red-600 font-medium' : 'text-slate-600'}>{fmtDate(u.expiresAt)}</span></td>
                  <td className="px-4 py-3 border-b border-slate-100 text-[11px] text-slate-500">{timeAgo(u.lastLoginAt)}</td>
                  <td className="px-4 py-3 border-b border-slate-100"><StatusDot status={u.status} /></td>
                  <td className="px-4 py-3 border-b border-slate-100 text-right"><button onClick={() => setOpenId(openId === u.id ? null : u.id)} className="text-[12px] text-indigo-600 hover:underline">{openId === u.id ? 'Close' : 'Manage'}</button></td>
                </tr>
                {openId === u.id && (
                  <tr><td colSpan={cols.length} className="bg-slate-50 border-b border-slate-200 px-4 py-4">
                    <ManageUser u={u} isSuper={isSuper} companies={companies} projects={projects} reload={reload} onClose={() => setOpenId(null)} />
                  </td></tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ManageUser({ u, isSuper, companies, projects, reload, onClose }:
  { u: AdminUser; isSuper: boolean; companies: Company[]; projects: Proj[]; reload: () => void; onClose: () => void }) {
  const [role, setRole]     = useState<Role>(u.role);
  const [companyId, setCompanyId] = useState<string | null>(u.companyId);
  const [expiry, setExpiry] = useState(toDateInput(u.expiresAt));
  const [grants, setGrants] = useState<string[]>(u.projectIds);
  const [pw, setPw]         = useState('');
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState<string | null>(null);

  const effectiveCompany = isSuper ? companyId : u.companyId;
  const companyProjects = projects.filter(p => p.companyId === effectiveCompany);
  const showGrants = role === 'client_user';
  const toggle = (id: string) => setGrants(g => g.includes(id) ? g.filter(x => x !== id) : [...g, id]);

  async function patch(body: Record<string, unknown>, done = 'Saved') {
    setBusy(true); setMsg(null);
    const res = await fetch(`/api/admin/users/${u.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setMsg(data.error || 'Update failed'); return; }
    setMsg(done); reload();
  }
  function saveAll() {
    const body: Record<string, unknown> = { name: u.name, expiresAt: expiry || null, password: pw || undefined };
    if (isSuper) { body.role = role; body.companyId = companyId; }
    if (showGrants) body.projectIds = grants;
    patch(body);
  }

  return (
    <div className="grid md:grid-cols-2 gap-6">
      <div>
        <h4 className="text-[10px] uppercase tracking-wider text-slate-400 mb-3">Role &amp; account</h4>
        {isSuper ? (
          <>
            <label className="block mb-3"><span className={labelCls}>Role</span>
              <select value={role} onChange={e => setRole(e.target.value as Role)} className={input}>
                <option value="client_user">Client user</option>
                <option value="company_admin">Company admin</option>
                <option value="super_admin">Super admin</option>
              </select></label>
            <label className="block mb-3"><span className={labelCls}>Company</span>
              <select value={companyId ?? ''} onChange={e => setCompanyId(e.target.value || null)} className={input} disabled={role === 'super_admin'}>
                <option value="">{role === 'super_admin' ? '— none (internal) —' : '— choose —'}</option>
                {companies.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
          </>
        ) : (
          <p className="text-[12px] text-slate-500 mb-3">Client user in your company.</p>
        )}
        <label className="block mb-3"><span className={labelCls}>Access expires</span>
          <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={input} />
          <span className="block text-[11px] text-slate-400 mt-1">Blank = follows the company’s expiry.</span></label>
        <label className="block"><span className={labelCls}>Reset password (optional)</span>
          <input type="text" value={pw} onChange={e => setPw(e.target.value)} placeholder="new temporary password (8+)" className={input} /></label>

        <div className="flex flex-wrap gap-2 mt-4">
          <button disabled={busy} onClick={saveAll} className={btnPrimary}>Save changes</button>
          {u.status !== 'suspended'
            ? <button disabled={busy} onClick={() => patch({ status: 'suspended' }, 'Suspended')} className={`${btn} border border-red-300 text-red-600 hover:bg-red-50`}>Suspend</button>
            : <button disabled={busy} onClick={() => patch({ status: 'active' }, 'Reactivated')} className={`${btn} border border-green-300 text-green-600 hover:bg-green-50`}>Reactivate</button>}
          <button disabled={busy} onClick={async () => {
            if (!confirm(`Remove ${u.name}?`)) return;
            const res = await fetch(`/api/admin/users/${u.id}`, { method: 'DELETE' });
            if (res.ok) { onClose(); reload(); } else { const d = await res.json().catch(() => ({})); setMsg(d.error || 'Delete failed'); }
          }} className={btnGhost}>Remove</button>
        </div>
        {msg && <p className="text-[12px] text-slate-500 mt-3">{msg}</p>}
      </div>

      <div>
        <h4 className="text-[10px] uppercase tracking-wider text-slate-400 mb-3">Project access {showGrants ? '' : '(admins see all)'}</h4>
        {!showGrants ? (
          <p className="text-[12px] text-slate-500 bg-white border border-slate-200 rounded-lg px-3 py-3">Admins can open every project in their scope — per-project limits don’t apply.</p>
        ) : companyProjects.length === 0 ? (
          <p className="text-[12px] text-slate-400">This company has no projects yet.</p>
        ) : (
          <>
            <p className="text-[11px] text-slate-400 mb-2">No projects selected = sees ALL company projects. Select some to restrict to just those.</p>
            <div className="space-y-1 max-h-56 overflow-y-auto pr-1">
              {companyProjects.map(p => {
                const on = grants.includes(p.id);
                return (
                  <button key={p.id} onClick={() => toggle(p.id)} className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-white text-left">
                    <span className={`w-8 h-5 rounded-full relative flex-shrink-0 transition-colors ${on ? 'bg-green-500' : 'bg-slate-300'}`}>
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} /></span>
                    <span className={`text-[12.5px] ${on ? 'text-slate-900' : 'text-slate-500'}`}>{p.name}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* ── Add user tab ────────────────────────────────────────────────────────── */
function AddUserTab({ isSuper, companies, projects, onDone }: { isSuper: boolean; companies: Company[]; projects: Proj[]; onDone: () => void }) {
  const [name, setName]   = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole]   = useState<Role>('client_user');
  const [companyId, setCompanyId] = useState<string>('');
  const [pw, setPw]       = useState('');
  const [expiry, setExpiry] = useState('');
  const [grants, setGrants] = useState<string[]>([]);
  const [busy, setBusy]   = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showGrants = role === 'client_user';
  const companyProjects = projects.filter(p => p.companyId === companyId);
  const toggle = (id: string) => setGrants(g => g.includes(id) ? g.filter(x => x !== id) : [...g, id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError(null); setBusy(true);
    const body: Record<string, unknown> = { name, email, password: pw || undefined, expiresAt: expiry || null };
    if (isSuper) { body.role = role; body.companyId = companyId || undefined; if (showGrants) body.projectIds = grants; }
    else if (showGrants) body.projectIds = grants;
    const res = await fetch('/api/admin/users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setError(data.error || 'Could not create user'); return; }
    onDone();
  }

  return (
    <form onSubmit={submit} className="rounded-xl border border-slate-200 bg-white max-w-2xl p-6">
      <div className="grid sm:grid-cols-2 gap-4">
        <label className="block"><span className={labelCls}>Full name</span>
          <input value={name} onChange={e => setName(e.target.value)} required placeholder="Taylor Nguyen" className={input} /></label>
        <label className="block"><span className={labelCls}>Email</span>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="taylor@company.com" className={input} /></label>
      </div>

      {isSuper && (
        <div className="grid sm:grid-cols-2 gap-4 mt-4">
          <label className="block"><span className={labelCls}>Company</span>
            <select value={companyId} onChange={e => setCompanyId(e.target.value)} required={role !== 'super_admin'} disabled={role === 'super_admin'} className={input}>
              <option value="">{role === 'super_admin' ? '— none (super admin) —' : '— choose company —'}</option>
              {companies.map(c => <option key={c.id} value={c.id}>{c.name} ({c.seatsUsed}/{c.seatLimit})</option>)}
            </select></label>
          <label className="block"><span className={labelCls}>Role</span>
            <select value={role} onChange={e => setRole(e.target.value as Role)} className={input}>
              <option value="client_user">Client user</option>
              <option value="company_admin">Company admin</option>
              <option value="super_admin">Super admin (full access, no company)</option>
            </select></label>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <label className="block"><span className={labelCls}>Temporary password</span>
          <input type="text" value={pw} onChange={e => setPw(e.target.value)} placeholder="8+ chars — share it with them" className={input} />
          <span className="block text-[11px] text-slate-400 mt-1">Blank = create as “pending” and set a password later.</span></label>
        <label className="block"><span className={labelCls}>Access expires (optional)</span>
          <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className={input} />
          <span className="block text-[11px] text-slate-400 mt-1">Blank = follows the company’s expiry.</span></label>
      </div>

      {showGrants && (
        <div className="mt-5">
          <span className={labelCls}>Restrict to specific projects (optional)</span>
          {!isSuper || companyId ? (
            companyProjects.length === 0
              ? <p className="text-[12px] text-slate-400">No projects in this company yet — leave blank; they’ll see projects as they’re added.</p>
              : <>
                  <p className="text-[11px] text-slate-400 mb-2">Leave all off = sees ALL company projects.</p>
                  <div className="border border-slate-200 rounded-lg p-1.5 space-y-1">
                    {companyProjects.map(p => {
                      const on = grants.includes(p.id);
                      return (
                        <button type="button" key={p.id} onClick={() => toggle(p.id)} className="w-full flex items-center gap-3 px-2.5 py-2 rounded-lg hover:bg-slate-50 text-left">
                          <span className={`w-8 h-5 rounded-full relative flex-shrink-0 transition-colors ${on ? 'bg-green-500' : 'bg-slate-300'}`}>
                            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'}`} /></span>
                          <span className={`text-[12.5px] ${on ? 'text-slate-900' : 'text-slate-500'}`}>{p.name}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
          ) : <p className="text-[12px] text-slate-400">Choose a company first to pick projects.</p>}
        </div>
      )}

      {error && <div className="mt-4 text-[13px] text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</div>}
      <div className="flex gap-3 mt-6">
        <button type="submit" disabled={busy} className={btnPrimary}>{busy ? 'Creating…' : 'Create user'}</button>
        <button type="button" onClick={onDone} className={btnGhost}>Cancel</button>
      </div>
    </form>
  );
}

/* ── Activity tab ────────────────────────────────────────────────────────── */
interface Ev { id: string; action: string; actorName: string | null; actorEmail: string | null; projectName: string | null; meta: Record<string, unknown> | null; ip: string | null; createdAt: string }

function describe(e: Ev): string {
  const who = e.actorName || e.actorEmail || 'Someone';
  const t = typeof e.meta?.targetEmail === 'string' ? ` · ${e.meta.targetEmail}` : '';
  switch (e.action) {
    case 'login': return `${who} signed in${e.meta?.bootstrap ? ' · created the first admin' : ''}`;
    case 'logout': return `${who} signed out`;
    case 'company.create': return `${who} created a company${typeof e.meta?.name === 'string' ? ` · ${e.meta.name}` : ''}`;
    case 'company.update': return `${who} updated a company`;
    case 'company.delete': return `${who} deleted a company${typeof e.meta?.name === 'string' ? ` · ${e.meta.name}` : ''}`;
    case 'user.invite': return `${who} added a user${t}`;
    case 'user.update': return `${who} updated a user${t}`;
    case 'user.delete': return `${who} removed a user${t}`;
    case 'user.password_change': return `${who} changed their password`;
    case 'project.open': return `${who} opened ${e.projectName ?? 'a project'}`;
    default: return `${who} · ${e.action}`;
  }
}

function ActivityTab() {
  const [events, setEvents] = useState<Ev[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    (async () => {
      setLoading(true);
      const res = await fetch('/api/admin/activity?limit=250', { cache: 'no-store' });
      const data = await res.json().catch(() => ({ events: [] }));
      setEvents(data.events ?? []); setLoading(false);
    })();
  }, []);

  if (loading) return <div className="space-y-1.5">{[...Array(6)].map((_, i) => <div key={i} className="h-12 bg-white border border-slate-200 rounded-lg animate-pulse" />)}</div>;
  if (!events.length) return <div className="rounded-xl border border-slate-200 bg-white text-center py-16 text-sm text-slate-500">No activity recorded yet. Logins and changes will appear here.</div>;
  return (
    <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100 overflow-hidden">
      {events.map(e => (
        <div key={e.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50">
          <span className="text-[10.5px] text-slate-400 w-28 flex-shrink-0">{new Date(e.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          <span className="text-[13px] text-slate-600 flex-1 min-w-0 truncate">{describe(e)}</span>
          <span className="text-[10px] text-slate-400 text-right hidden sm:block flex-shrink-0">{e.ip || ''}</span>
        </div>
      ))}
      <p className="text-[11px] text-slate-400 px-4 py-3">Real events, newest first.</p>
    </div>
  );
}
