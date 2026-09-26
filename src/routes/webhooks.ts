import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { queryOne } from '../db/index.js';
import { config } from '../config.js';

export async function webhookRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Verifiable Certificate & Participation Record (T4 Stretch)
  fastify.get('/certificates/:projectId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };

    const project = queryOne<{
      id: string;
      title: string;
      team_id: string;
      team_name: string;
      track_name: string;
      submitted_at: string;
    }>(
      `SELECT p.id, p.title, p.team_id, t.name as team_name, tr.name as track_name, p.submitted_at
       FROM projects p
       LEFT JOIN teams t ON p.team_id = t.id
       LEFT JOIN tracks tr ON p.track_id = tr.id
       WHERE p.id = ?`,
      projectId
    );

    if (!project) {
      return reply.code(404).send({ error: 'Project certificate not found' });
    }

    // Cryptographic signature of participation
    const payload = `${project.id}:${project.team_id}:${project.submitted_at}`;
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({
        event: 'DOGFOOD 2026',
        project,
        verification: {
          payload,
          algorithm: 'HMAC-SHA256',
          signature,
          verify_url: `${config.baseUrl}/certificates/${project.id}`,
        },
      });
    }

    return reply.view('certificate.ejs', {
      title: `Certificate — ${project.title}`,
      project,
      signature,
      user: req.user,
    });
  });

  // Health check endpoint
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', time: new Date().toISOString() });
  });
}
