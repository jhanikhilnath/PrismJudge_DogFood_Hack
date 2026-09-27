import Fastify, { FastifyInstance } from 'fastify';
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
import { getAllTracks, getEvent, getProjects, getSystemStats, isSubmissionsClosed } from './db/index.js';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: false, // Clean stdout for docker startup output
    trustProxy: true,
  });

  // 1. Core middleware plugins
  await fastify.register(fastifyCors, { origin: true });
  await fastify.register(fastifyCookie, { secret: config.sessionSecret });
  await fastify.register(fastifyFormbody);

  // 2. Static asset serving
  await fastify.register(fastifyStatic, {
    root: config.publicDir,
    prefix: '/static/',
  });

  // 3. Server-side templates (EJS)
  await fastify.register(fastifyView, {
    engine: { ejs },
    root: config.viewsDir,
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

  // 5b. Enterprise Security Headers Hook
  fastify.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('X-XSS-Protection', '1; mode=block');
  });

  // 5c. Liveness and Readiness Probes
  fastify.get('/healthz', async (_req, reply) => {
    return reply.code(200).send({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get('/readyz', async (_req, reply) => {
    const stats = getSystemStats();
    return reply.code(200).send({
      status: 'ready',
      database: 'connected',
      projects: stats.projectCount,
      judges: stats.judgeCount,
      scores: stats.scoreCount,
      timestamp: new Date().toISOString(),
    });
  });

  // 6. Register Application Routes
  await fastify.register(authRoutes);
  await fastify.register(projectRoutes);
  await fastify.register(judgingRoutes);
  await fastify.register(organizerRoutes);
  await fastify.register(communityRoutes);
  await fastify.register(pairwiseRoutes);
  await fastify.register(webhookRoutes);

  // 7. Official Landing & Home Portal
  fastify.get('/', async (req, reply) => {
    const event = getEvent();
    const tracks = getAllTracks();
    const stats = getSystemStats();
    const featuredProjects = getProjects({ limit: 3 });
    const isClosed = isSubmissionsClosed(event);

    const publicStats = {
      projectCount: stats.projectCount,
      judgeCount: stats.judgeCount,
      trackCount: stats.trackCount,
      scoreCount: stats.scoreCount,
    };

    if (req.headers.accept?.includes('application/json') && !req.headers.accept?.includes('text/html')) {
      return reply.send({
        event,
        stats: publicStats,
        tracks,
        featuredProjects,
        isClosed,
      });
    }

    return reply.view('home.ejs', {
      title: 'DOGFOOD 2026 — Self-Hostable Hackathon & Evaluation Platform',
      event,
      tracks,
      stats: publicStats,
      featuredProjects,
      isClosed,
      user: req.user,
    });
  });

  // 8. Custom 404 (Not Found) & Branded Error Handlers
  fastify.setNotFoundHandler(async (req, reply) => {
    if (req.headers.accept?.includes('text/html')) {
      return reply.code(404).view('404.ejs', {
        title: 'Page Not Found — DOGFOOD 2026',
        user: req.user,
        path: req.url,
      });
    }
    return reply.code(404).send({ error: 'Not Found', path: req.url });
  });

  fastify.setErrorHandler(async (error: any, req, reply) => {
    if (error?.statusCode === 403 && req.headers.accept?.includes('text/html')) {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — DOGFOOD 2026',
        user: req.user,
        message: error.message || 'You do not have permission to access this resource.',
      });
    }
    return reply.code(error?.statusCode || 500).send({
      error: error?.name || 'InternalServerError',
      message: error?.message || 'An error occurred',
    });
  });

  return fastify;
}
