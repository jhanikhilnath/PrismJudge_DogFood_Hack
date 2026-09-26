import crypto from 'node:crypto';
import { queryOne } from '../db/index.js';

export interface UserSession {
  userId: string;
  email: string;
  name: string;
  role: 'visitor' | 'participant' | 'judge' | 'organizer' | 'admin';
  token: string;
  expiresAt: string;
}

export function hashPassword(password: string): string {
  const salt = 'dogfood_salt_2026';
  return crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex');
}

export function generateSessionToken(prefix = 'sess'): string {
  return `${prefix}_${crypto.randomBytes(16).toString('hex')}`;
}

export function timingSafeTokenEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf-8');
  const bufB = Buffer.from(b, 'utf-8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function getSessionUser(token: string): UserSession | null {
  if (!token || typeof token !== 'string') return null;

  const sql = `
    SELECT 
      s.token,
      s.expires_at as expiresAt,
      u.id as userId,
      u.email,
      u.name,
      u.role
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.token = ?
  `;

  const row = queryOne<UserSession>(sql, token);
  if (!row) return null;

  const now = new Date().toISOString();
  if (row.expiresAt < now) {
    return null;
  }

  return row;
}
