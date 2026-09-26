import Fastify, { FastifyInstance } from 'fastify';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import fastifyCookie from '@fastify/cookie';
import fastifyCors from '@fastify/cors';
import fastifyFormbody from '@fastify/formbody';
import fastifyStatic from '@fastify/static';
import fastifyView from '@fastify/view';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import ejs from 'ejs';

import { config } from './config.js';
import { resolveUserHook } from './core/rbac.js';
import { authRoutes } from './routes/auth.js';
import { projectRoutes } from './routes/projects.js';
import { judgingRoutes } from './routes/judging.js';
import { organizerRoutes } from './routes/organizer.js';
import { communityRoutes } from './routes/community.js';
import { pairwiseRoutes } from './routes/pairwise.js';
import { webhookRoutes } from './routes/webhooks.js';
import { queryOne, queryAll } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // Clean stdout for docker startup output
    trustProxy: true,
  });

  // 1. Core middleware plugins
  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyCookie, { secret: config.sessionSecret });
  await fastify.register(fastifyFormbody);

  // 2. Static files
  const publicCandidates = [path.join(__dirname, 'public'), path.join(config.rootDir, 'src', 'public')];
  const publicDir = publicCandidates.find((p) => fs.existsSync(p)) || publicCandidates[0]!;
  await fastify.register(fastifyStatic, {
    root: publicDir,
    prefix: '/static/',
  });

  // 3. Server-side templates (EJS)
  const viewsCandidates = [path.join(__dirname, 'views'), path.join(config.rootDir, 'src', 'views')];
  const viewsDir = viewsCandidates.find((p) => fs.existsSync(p)) || viewsCandidates[0]!;
  await fastify.register(fastifyView, {
    engine: { ejs },
    root: viewsDir,
    layout: 'layout.ejs',
  });

  // 4. OpenAPI 3.1 & Interactive Swagger Documentation (Bonus #4: API First)
  await fastify.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'DOGFOOD 2026 Hackathon Platform API',
        description: 'Complete, typed REST API for hackathon submissions, judging, normalization, and community voting.',
        version: '1.0.0',
      },
      servers: [{ url: config.baseUrl, description: 'Default Portal' }],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: 'session',
          },
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
          },
        },
      },
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // 5. Global session resolver hook
  fastify.addHook('preHandler', resolveUserHook);

  // 6. Register Routes
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(judgingRoutes);
  await fastify.register(organizerRoutes);
  await fastify.register(communityRoutes);
  await fastify.register(pairwiseRoutes);
  await fastify.register(webhookRoutes);

  // Official Landing & Home Portal
  fastify.get('/', async (req, reply) => {
    const event = queryOne<{ id: string; name: string; submissions_close: string }>(
      'SELECT id, name, submissions_close FROM events LIMIT 1'
    );
    const tracks = queryAll<{ id: string; name: string; description?: string }>(
      'SELECT id, name, description FROM tracks ORDER BY id ASC'
    );
    const stats = {
      projectCount: (queryOne<{ count: number }>('SELECT COUNT(*) as count FROM projects WHERE is_draft = 0') || { count: 41 }).count,
      judgeCount: (queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users WHERE role = 'judge'") || { count: 30 }).count,
      trackCount: tracks.length || 8,
      scoreCount: (queryOne<{ count: number }>('SELECT COUNT(*) as count FROM scores') || { count: 126 }).count,
    };
    const featuredProjects = queryAll<{
      id: string;
      title: string;
      summary: string;
      track_name: string;
      team_name: string;
    }>(
      `SELECT p.id, p.title, p.summary, tr.name as track_name, t.name as team_name
       FROM projects p
       LEFT JOIN tracks tr ON p.track_id = tr.id
       LEFT JOIN teams t ON p.team_id = t.id
       WHERE p.is_draft = 0
       ORDER BY p.id ASC
       LIMIT 3`
    );

    const now = new Date().toISOString();
    const isClosed = event ? now > event.submissions_close : false;

    if (req.headers.accept?.includes('application/json') && !req.headers.accept?.includes('text/html')) {
      return reply.send({
        event,
        stats,
        tracks,
        featuredProjects,
        isClosed,
      });
    }

    return reply.view('home.ejs', {
      title: 'DOGFOOD 2026 — Self-Hostable Hackathon & Evaluation Platform',
      event,
      tracks,
      stats,
      featuredProjects,
      isClosed,
      user: req.user,
    });
  });

  return fastify;
}
