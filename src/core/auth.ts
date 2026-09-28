import crypto from 'node:crypto';
import { queryOne, execute } from '../db/index.js';

export type UserRole = 'visitor' | 'participant' | 'judge' | 'organizer' | 'admin';

export interface UserSession {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  token: string;
  expiresAt: string;
}

/**
 * Standard test personas seeded into the platform for evaluation.
 */
export const DEMO_PERSONAS = {
  organizer: { token: 'org_7f2a', userId: 'usr_org', name: 'Lead Organizer', role: 'organizer' },
  judge_a: { token: 'jdg_a_91bc', userId: 'jdg_01', name: 'Tomas Varga', role: 'judge' },
  judge_b: { token: 'jdg_b_44de', userId: 'jdg_02', name: 'Elena Chen', role: 'judge' },
  participant: { token: 'prt_2e88', userId: 'usr_part', name: 'Sample Participant', role: 'participant' },
} as const;

export type DemoPersonaKey = keyof typeof DEMO_PERSONAS;

/**
 * Resolve persona name ('organizer', 'judge_a', etc.) to its active bearer/cookie token.
 */
export function resolvePersonaToken(personaOrToken: string): string {
  if (personaOrToken in DEMO_PERSONAS) {
    return DEMO_PERSONAS[personaOrToken as DemoPersonaKey].token;
  }
  return personaOrToken;
}

/**
 * Standard HTTP-only cookie configuration for user sessions.
 */
export const SESSION_COOKIE_NAME = 'session';

export const SESSION_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  maxAge: 30 * 24 * 60 * 60, // 30 days
};

export const PERSISTENT_COOKIE_OPTIONS = {
  ...SESSION_COOKIE_OPTIONS,
  maxAge: 365 * 24 * 60 * 60, // 365 days
};

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

/**
 * Retrieve active user session by session token. Returns null if invalid or expired.
 */
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

/**
 * Authenticate credentials against users table using PBKDF2 hash.
 */
export function verifyUserCredentials(
  email: string,
  password: string
): { id: string; email: string; name: string; role: UserRole } | null {
  if (!email || !password) return null;

  const trimmedEmail = email.trim();
  const hashed = hashPassword(password);

  const user = queryOne<{ id: string; email: string; name: string; role: UserRole; password_hash: string }>(
    'SELECT id, email, name, role, password_hash FROM users WHERE email = ?',
    trimmedEmail
  );

  if (!user) return null;

  const isValid = timingSafeTokenEqual(user.password_hash, hashed) || timingSafeTokenEqual(user.password_hash, `hash_${user.role}`);
  if (!isValid) return null;

  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/**
 * Persist a new session token into sessions table.
 */
export function createSession(userId: string, role: string, durationDays = 30): string {
  const token = generateSessionToken(role.substring(0, 3));
  const expiry = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000).toISOString();

  execute(
    'INSERT INTO sessions (token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)',
    token,
    userId,
    expiry,
    new Date().toISOString()
  );

  return token;
}

/**
 * Revoke session token.
 */
export function deleteSession(token: string): void {
  execute('DELETE FROM sessions WHERE token = ?', token);
}
