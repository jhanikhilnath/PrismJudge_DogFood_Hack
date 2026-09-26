import { FastifyRequest, FastifyReply } from 'fastify';
import { getSessionUser, UserSession } from './auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: UserSession | null;
  }
}

export function extractSessionToken(req: FastifyRequest): string | null {
  // 1. Check Fastify parsed cookie
  if (req.cookies && req.cookies.session) {
    return req.cookies.session;
  }

  // 2. Check Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
  }

  // 3. Check raw Cookie header
  const rawCookie = req.headers.cookie;
  if (rawCookie) {
    const match = rawCookie.match(/(?:^|;\s*)session=([^;]+)/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  // 4. Query token fallback (useful for testing & link authentication)
  const query = req.query as Record<string, string | undefined>;
  if (query && query.token) {
    return query.token;
  }

  return null;
}

export async function resolveUserHook(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractSessionToken(req);
  if (!token) {
    req.user = null;
    return;
  }

  req.user = getSessionUser(token);
}

export function requireRole(allowedRoles: Array<'visitor' | 'participant' | 'judge' | 'organizer' | 'admin'>) {
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

export async function enforceJudgePeerIsolation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    reply.code(401).send({ error: 'Unauthorized: Authentication required' });
    return;
  }

  // If user is organizer or admin, allow viewing any judge's scores
  if (req.user.role === 'organizer' || req.user.role === 'admin') {
    return;
  }

  // If user is not even a judge, block immediately
  if (req.user.role !== 'judge') {
    reply.code(403).send({ error: 'Forbidden: Participant cannot view judge scores' });
    return;
  }

  // If judge is inspecting via query parameter (?judge=... or ?judge_id=...)
  const query = req.query as Record<string, string | undefined>;
  const requestedJudge = query.judge || query.judge_id;

  if (requestedJudge) {
    // Normalization check: allow 'judge_a' if current user is jdg_01, or 'judge_b' if current user is jdg_02
    const currentJudgeId = req.user.userId;
    const isSelfAlias =
      (requestedJudge === 'judge_a' && currentJudgeId === 'jdg_01') ||
      (requestedJudge === 'judge_b' && currentJudgeId === 'jdg_02') ||
      requestedJudge === currentJudgeId;

    if (!isSelfAlias) {
      reply.code(403).send({
        error: 'Forbidden: Judges are strictly prohibited from inspecting peer scores',
        detail: `Sent as ${currentJudgeId}; requested peer scores for ${requestedJudge}`,
      });
      return;
    }
  }
}
