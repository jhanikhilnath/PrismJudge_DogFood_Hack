import { FastifyRequest, FastifyReply } from 'fastify';
import { getSessionUser, UserRole, UserSession } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserSession | null;
  }
}

/**
 * Resolve judge aliases ('judge_a', 'judge_b') to canonical user IDs ('jdg_01', 'jdg_02').
 */
export function resolveJudgeAlias(aliasOrId: string): string {
  if (aliasOrId === 'judge_a') return 'jdg_01';
  if (aliasOrId === 'judge_b') return 'jdg_02';
  return aliasOrId;
}

/**
 * Check if the requested judge identifier matches the currently authenticated judge.
 */
export function isJudgeSelf(requestedJudge: string, currentJudgeId: string): boolean {
  return resolveJudgeAlias(requestedJudge) === currentJudgeId;
}

/**
 * Extract session token from cookie, Authorization bearer header, or query param fallback.
 */
export function extractSessionToken(req: FastifyRequest): string | null {
  // 1. Fastify parsed cookie
  if (req.cookies?.session) {
    return req.cookies.session;
  }

  // 2. Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  // 3. Raw Cookie header fallback
  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const match = rawCookie.match(/(?:^|;\s*)session=([^;]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  // 4. Query token parameter fallback (for test automation and deep-linking)
  const query = req.query as Record<string, string | undefined>;
  if (query?.token) {
    return query.token;
  }

  return null;
}

/**
 * Global Fastify preHandler hook: resolves session token to req.user.
 */
export async function resolveUserHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractSessionToken(req);
  req.user = token ? getSessionUser(token) : null;
}

/**
 * RBAC route protection middleware: gates access to specific roles.
 */
export function requireRole(allowedRoles: UserRole[]) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!req.user) {
      reply.code(401).send({ error: 'Unauthorized: Authentication required' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      reply.code(403).send({ error: 'Forbidden: Insufficient role permissions' });
      return;
    }
  };
}

/**
 * Enforce hard peer isolation: prevents judges from snooping on peer evaluations.
 * Organizers and administrators have full auditing privileges.
 */
export async function enforceJudgePeerIsolation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    reply.code(401).send({ error: 'Unauthorized: Authentication required' });
    return;
  }

  // Organizers and admins have unrestricted read access to audit scores
  if (req.user.role === 'organizer' || req.user.role === 'admin') {
    return;
  }

  // Non-judges (e.g. participants) are strictly forbidden
  if (req.user.role !== 'judge') {
    reply.code(403).send({ error: 'Forbidden: Participant cannot view judge scores' });
    return;
  }

  // If a judge queries a specific target judge via query parameters (?judge=... or ?judge_id=...)
  const query = req.query as Record<string, string | undefined>;
  const requestedJudge = query.judge || query.judge_id;

  if (requestedJudge) {
    const currentJudgeId = req.user.userId;
    if (!isJudgeSelf(requestedJudge, currentJudgeId)) {
      reply.code(403).send({
        error: 'Forbidden: Judges are strictly prohibited from inspecting peer scores',
        detail: `Sent as ${currentJudgeId}; requested peer scores for ${requestedJudge}`,
      });
      return;
    }
  }
}
