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

  // Root redirect to gallery
  fastify.get('/', async (_req, reply) => {
    return reply.redirect('/projects');
  });

  return fastify;
}
