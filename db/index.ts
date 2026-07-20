/**
 * db/index.ts — Drizzle client on Neon serverless (auth tables).
 *
 * Lazy init so `next build` doesn't fail collecting page data before
 * DATABASE_URL exists.
 *
 * ⚠️ CACHE FIX (carried over from the Content Audit app): the
 * @neondatabase/serverless driver queries over `fetch`, and Next.js App Router
 * caches those fetch responses in its Data Cache → reads return STALE data.
 * We pass `{ fetchOptions: { cache: 'no-store' } }` so every auth read reflects
 * recent writes (a suspended user is blocked immediately, a new grant applies on
 * the next request, etc.). Do NOT remove this.
 */

import { neon } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-http';
import * as schema from './schema';

type DbType = ReturnType<typeof drizzle<typeof schema>>;

let _instance: DbType | undefined;

function getInstance(): DbType {
  if (_instance) return _instance;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL environment variable is not set');
  _instance = drizzle(neon(url, { fetchOptions: { cache: 'no-store' } }), { schema });
  return _instance;
}

export const db = new Proxy({} as DbType, {
  get(_, prop) {
    return Reflect.get(getInstance(), prop);
  },
});

export * from './schema';
