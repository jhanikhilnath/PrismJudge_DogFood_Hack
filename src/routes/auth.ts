import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import {
  createSession,
  deleteSession,
  resolvePersonaToken,
  verifyUserCredentials,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  PERSISTENT_COOKIE_OPTIONS,
} from '../core/auth.js';
import { queryOne, queryAll } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';
import { rateLimit } from '../core/rateLimit.js';

interface LoginBody {
  email?: string;
  password?: string;
  persona?: string;
  token?: string;
  redirect?: string;
}

interface AuthQuery {
  redirect?: string;
  error?: string;
}

export function getRoleDefaultPath(role: string): string {
  switch (role) {
    case 'organizer':
    case 'admin':
      return '/organizer/dashboard';
    case 'judge':
      return '/judge/dashboard';
    case 'participant':
    default:
      return '/projects';
  }
}

export function sanitizeRedirect(url?: string | null): string {
  if (!url || typeof url !== 'string') return '/projects';
  const trimmed = url.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\')) {
    return trimmed;
  }
  return '/projects';
}

export function resolveSmartRedirect(targetRole: string, requestedRedirect?: string | null): string {
  if (!requestedRedirect || typeof requestedRedirect !== 'string') {
    return getRoleDefaultPath(targetRole);
  }

  const candidate = requestedRedirect.trim();
  if (!candidate || candidate === '/' || candidate === '/login') {
    return getRoleDefaultPath(targetRole);
  }

  // Validate local relative path
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) {
    return getRoleDefaultPath(targetRole);
  }

  const path = candidate.split('?')[0];

  // Organizer routes protection
  if (path.startsWith('/organizer')) {
    if (targetRole === 'organizer' || targetRole === 'admin') {
      return candidate;
    }
    return getRoleDefaultPath(targetRole);
  }

  // Judge routes protection
  if (path.startsWith('/judge')) {
    if (targetRole === 'judge' || targetRole === 'organizer' || targetRole === 'admin') {
      return candidate;
    }
    return getRoleDefaultPath(targetRole);
  }

  // Submission route: judges are blocked from submitting, so route them to judge dashboard
  if (path === '/projects/new' && targetRole === 'judge') {
    return '/judge/dashboard';
  }

  // If candidate was generic /projects and switching to organizer or judge, lead them directly to their operational console/dashboard
  if (candidate === '/projects') {
    return getRoleDefaultPath(targetRole);
  }

  return candidate;
}

export async function authRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. JSON API Login Endpoint (email & password)
  fastify.post<{ Body: LoginBody }>(
    '/api/auth/login',
    {
      preHandler: [rateLimit('auth')],
    },
    async (req: FastifyRequest<{ Body: LoginBody }>, reply: FastifyReply) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return reply.code(400).send({ error: 'Email and password are required' });
    }

    const user = verifyUserCredentials(email, password);
    if (!user) {
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const token = createSession(user.id, user.role);
    reply.setCookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);

    logAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: 'LOGIN',
      resourceType: 'session',
      ipAddress: req.ip,
    });

    return reply.send({
      message: 'Logged in successfully',
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
      cookie: `Cookie: session=${token}`,
    });
  });

  // 2. Web Sign-In Page (HTML)
  fastify.get('/login', async (req: FastifyRequest<{ Querystring: AuthQuery }>, reply: FastifyReply) => {
    const query = req.query || {};
    return reply.view('login.ejs', {
      title: 'Sign In — PrismJudge',
      user: req.user,
      redirect: sanitizeRedirect(query.redirect),
      error: query.error || null,
    });
  });

  // 3. Web Form Sign-In Submission (Persona, Direct Token, or Email/Password)
  fastify.post<{ Body: LoginBody; Querystring: AuthQuery }>('/login', {
    preHandler: [rateLimit('auth')],
  }, async (req, reply: FastifyReply) => {
    const body = req.body || {};
    const redirectUrl = sanitizeRedirect(body.redirect || req.query?.redirect);
    const isHtml = req.headers.accept?.includes('text/html') || !req.headers['content-type']?.includes('application/json');

    // Case A: 1-Click Demo Persona Login
    if (body.persona) {
      const resolvedToken = resolvePersonaToken(body.persona);
      let session = queryOne<{ token: string; user_id: string; role: string; name: string }>(
        `SELECT s.token, s.user_id, u.role, u.name
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.token = ?
         ORDER BY s.created_at DESC
         LIMIT 1`,
        resolvedToken
      );

      if (!session) {
        session = queryOne<{ token: string; user_id: string; role: string; name: string }>(
          `SELECT s.token, s.user_id, u.role, u.name
           FROM sessions s
           JOIN users u ON s.user_id = u.id
           WHERE s.user_id = ?
           ORDER BY s.created_at DESC
           LIMIT 1`,
          body.persona
        );
      }

      if (session) {
        reply.setCookie(SESSION_COOKIE_NAME, session.token, PERSISTENT_COOKIE_OPTIONS);
        reply.setCookie('prism_flash_switched', session.role + ':' + encodeURIComponent(session.name), {
          path: '/',
          httpOnly: false,
          sameSite: 'lax',
          maxAge: 15,
        });

        const targetUrl = resolveSmartRedirect(session.role, body.redirect || req.query?.redirect);
        if (isHtml) return reply.redirect(targetUrl);
        return reply.send({ message: 'Logged in as demo persona', token: session.token, redirect: targetUrl });
      }
    }

    // Case B: Direct Session Token submission
    if (body.token && typeof body.token === 'string') {
      const trimmed = body.token.trim();
      const session = queryOne<{ token: string; user_id: string }>(
        'SELECT token, user_id FROM sessions WHERE token = ?',
        trimmed
      );

      if (session) {
        reply.setCookie(SESSION_COOKIE_NAME, trimmed, PERSISTENT_COOKIE_OPTIONS);
        if (isHtml) return reply.redirect(redirectUrl);
        return reply.send({ message: 'Logged in with session token', token: trimmed });
      }

      if (isHtml) {
        return reply.redirect(`/login?error=Invalid+session+token&redirect=${encodeURIComponent(redirectUrl)}`);
      }
      return reply.code(401).send({ error: 'Invalid session token' });
    }

    // Case C: Email & Password credentials
    const { email, password } = body;
    if (!email || !password) {
      if (isHtml) {
        return reply.redirect(`/login?error=Email+and+password+are+required&redirect=${encodeURIComponent(redirectUrl)}`);
      }
      return reply.code(400).send({ error: 'Email and password are required' });
    }

    const user = verifyUserCredentials(email, password);
    if (!user) {
      if (isHtml) {
        return reply.redirect(`/login?error=Invalid+email+or+password&redirect=${encodeURIComponent(redirectUrl)}`);
      }
      return reply.code(401).send({ error: 'Invalid email or password' });
    }

    const token = createSession(user.id, user.role);
    reply.setCookie(SESSION_COOKIE_NAME, token, SESSION_COOKIE_OPTIONS);

    logAuditEvent({
      actorId: user.id,
      actorRole: user.role,
      action: 'LOGIN',
      resourceType: 'session',
      ipAddress: req.ip,
    });

    if (isHtml) return reply.redirect(redirectUrl);
    return reply.send({
      message: 'Logged in successfully',
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      token,
    });
  });

  // 4. Quick Persona Switcher (/api/auth/switch/:roleOrToken)
  fastify.get('/api/auth/switch/:roleOrToken', async (req: FastifyRequest<{ Params: { roleOrToken: string }; Querystring: AuthQuery }>, reply: FastifyReply) => {
    const { roleOrToken } = req.params;
    const token = resolvePersonaToken(roleOrToken);

    let session = queryOne<{ token: string; user_id: string; role: string; name: string }>(
      `SELECT s.token, s.user_id, u.role, u.name
       FROM sessions s
       JOIN users u ON s.user_id = u.id
       WHERE s.token = ?
       ORDER BY s.created_at DESC
       LIMIT 1`,
      token
    );

    if (!session) {
      session = queryOne<{ token: string; user_id: string; role: string; name: string }>(
        `SELECT s.token, s.user_id, u.role, u.name
         FROM sessions s
         JOIN users u ON s.user_id = u.id
         WHERE s.user_id = ?
         ORDER BY s.created_at DESC
         LIMIT 1`,
        roleOrToken
      );
    }

    if (!session) {
      return reply.code(404).send({ error: 'Session token or persona not found' });
    }

    reply.setCookie(SESSION_COOKIE_NAME, session.token, PERSISTENT_COOKIE_OPTIONS);
    reply.setCookie('prism_flash_switched', session.role + ':' + encodeURIComponent(session.name), {
      path: '/',
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 15,
    });

    const targetUrl = resolveSmartRedirect(session.role, req.query?.redirect);
    return reply.redirect(targetUrl);
  });

  // 5. Browser Logout (GET /logout)
  fastify.get('/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) {
      logAuditEvent({
        actorId: req.user.userId,
        actorRole: req.user.role,
        action: 'LOGOUT',
        resourceType: 'session',
      });
    }
    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.redirect('/login');
  });

  // 6. JSON API Logout (POST /api/auth/logout)
  fastify.post('/api/auth/logout', async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.user) {
      deleteSession(req.user.token);
      logAuditEvent({
        actorId: req.user.userId,
        actorRole: req.user.role,
        action: 'LOGOUT',
        resourceType: 'session',
      });
    }

    reply.clearCookie(SESSION_COOKIE_NAME, { path: '/', httpOnly: true, sameSite: 'lax' });
    return reply.send({ message: 'Logged out successfully' });
  });

  // 7. Current Authenticated Profile (GET /api/auth/me)
  fastify.get('/api/auth/me', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.send({ authenticated: false, role: 'visitor' });
    }
    return reply.send({
      authenticated: true,
      user: {
        id: req.user.userId,
        email: req.user.email,
        name: req.user.name,
        role: req.user.role,
      },
      token: req.user.token,
    });
  });

  // 8. Test Sessions Directory (for acceptance test runners and evaluation)
  fastify.get('/api/test-sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    if (process.env.NODE_ENV !== 'test' && (!req.user || req.user.role !== 'organizer')) {
      return reply.code(403).send({ error: 'Forbidden', message: 'Test sessions directory is restricted' });
    }

    const sessions = queryAll<{ token: string; email: string; name: string; role: string }>(`
      SELECT s.token, u.email, u.name, u.role
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      ORDER BY s.created_at ASC
    `);

    return reply.send({
      description: 'Pre-seeded sessions for acceptance checker and judging evaluation',
      sessions: sessions.map((s) => ({
        role: s.role,
        name: s.name,
        email: s.email,
        token: s.token,
        header: `Cookie: session=${s.token}`,
        bearer: `Authorization: Bearer ${s.token}`,
      })),
    });
  });
}
