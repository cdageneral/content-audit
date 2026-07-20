/**
 * middleware.ts — the login wall for PAGE routes.
 *
 * No-op unless AUTH_ENFORCED='true'. When on, any unauthenticated request to a
 * protected page is redirected to /sign-in?next=<path>; /admin additionally
 * requires an admin role. API routes are NOT gated here — they enforce access
 * per-handler (see snippets/wiring-your-resource-routes.md) so server-to-server
 * calls (QStash webhook) and the list-filter behaviour keep working.
 *
 * Edge-safe: verifySessionToken uses Web Crypto only; no DB, no node APIs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken } from '@/lib/auth/jwt';
import { SESSION_COOKIE, authEnforced, canReachAdmin } from '@/lib/auth/config';

export async function middleware(req: NextRequest) {
  if (!authEnforced()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const claims = token ? await verifySessionToken(token) : null;

  if (!claims) {
    const url = req.nextUrl.clone();
    url.pathname = '/sign-in';
    url.searchParams.set('next', pathname + req.nextUrl.search);
    return NextResponse.redirect(url);
  }

  if (pathname.startsWith('/admin') && !canReachAdmin(claims.role)) {
    const url = req.nextUrl.clone();
    url.pathname = '/';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

/**
 * Protect the app's pages. Add/adjust entries to match your route tree. The
 * sign-in page, API routes, Next internals and static files are intentionally
 * absent so they stay reachable while signed out.
 */
export const config = {
  matcher: ['/', '/projects/:path*', '/audit/:path*', '/admin/:path*', '/account/:path*'],
};
