import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { requireRole } from '../core/rbac.js';
import { solveBradleyTerry } from '../engine/pairwise.js';
import { queryAll, execute } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

export async function pairwiseRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Fetch Bradley-Terry model output
  fastify.get('/api/pairwise/ratings', async (_req: FastifyRequest, reply: FastifyReply) => {
    const results = solveBradleyTerry();
    return reply.send(results);
  });

  // Get Next Pair for Judging
  fastify.get(
    '/api/pairwise/match',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Pick two distinct projects with fewest comparisons
      const projects = queryAll<{ id: string; title: string; track_name: string; summary: string }>(`
        SELECT p.id, p.title, tr.name as track_name, p.summary
        FROM projects p
        LEFT JOIN tracks tr ON p.track_id = tr.id
        WHERE p.is_draft = 0
        ORDER BY RANDOM()
        LIMIT 2
      `);

      if (projects.length < 2) {
        return reply.code(400).send({ error: 'Not enough projects available for pairwise comparison' });
      }

      return reply.send({
        project_a: projects[0],
        project_b: projects[1],
      });
    }
  );

  // Submit Pairwise Comparison Decision
  fastify.post(
    '/api/pairwise/vote',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body as any) || {};
      const { project_a, project_b, winner } = body;

      if (!project_a || !project_b || !winner) {
        return reply.code(400).send({ error: 'project_a, project_b, and winner are required' });
      }

      if (!['project_a', 'project_b', 'tie'].includes(winner)) {
        return reply.code(400).send({ error: 'winner must be "project_a", "project_b", or "tie"' });
      }

      const matchId = `pw_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
      const judgeId = req.user!.userId;
      const now = new Date().toISOString();

      execute(
        `INSERT INTO pairwise_comparisons (id, judge_id, project_a, project_b, winner, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        matchId,
        judgeId,
        project_a,
        project_b,
        winner,
        now
      );

      logAuditEvent({
        actorId: judgeId,
        actorRole: req.user!.role,
        action: 'PAIRWISE_DECISION_RECORDED',
        resourceType: 'pairwise_comparison',
        resourceId: matchId,
        payload: { project_a, project_b, winner },
        ipAddress: req.ip,
      });

      return reply.code(201).send({
        message: 'Pairwise comparison recorded',
        matchId,
        winner,
      });
    }
  );

  // Pairwise judging interactive HTML view
  fastify.get('/judge/pairwise', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'judge' && req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.redirect('/api/auth/switch/judge_a?redirect=/judge/pairwise');
    }

    const projects = queryAll<{ id: string; title: string; track_name: string; summary: string }>(`
      SELECT p.id, p.title, tr.name as track_name, p.summary
      FROM projects p
      LEFT JOIN tracks tr ON p.track_id = tr.id
      WHERE p.is_draft = 0
      ORDER BY RANDOM()
      LIMIT 2
    `);

    const ratings = solveBradleyTerry();

    return reply.view('pairwise.ejs', {
      title: 'Pairwise Judging Mode — DOGFOOD 2026',
      user: req.user,
      project_a: projects[0],
      project_b: projects[1],
      ratings,
    });
  });
}
