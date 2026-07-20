/**
 * lib/auth/passwords.ts — password hashing (verbatim from the kit).
 *
 * node:crypto scrypt (memory-hard KDF) with a per-password random salt — no
 * external dependency, only called from node-runtime route handlers. Stored
 * format: scrypt$<saltHex>$<keyHex>
 */

import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const KEYLEN = 64;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const key  = scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, keyHex] = parts;
  let expected: Buffer;
  try {
    expected = Buffer.from(keyHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== KEYLEN) return false;
  const actual = scryptSync(password, salt, KEYLEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
