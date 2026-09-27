import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { requireRole } from '../core/rbac.js';
import { selectActivePair, solveBradleyTerry } from '../engine/pairwise.js';
import { execute, getProjectsForComparison, queryOne } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

interface PairwiseVoteBody {
  project_a?: string;
  project_b?: string;
  winner?: 'project_a' | 'project_b' | 'tie';
}

export async function pairwiseRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. Fetch Bradley-Terry Model Output & Latent Skills
  fastify.get('/api/pairwise/ratings', async (_req: FastifyRequest, reply: FastifyReply) => {
    const results = solveBradleyTerry();
    return reply.send(results);
  });

  // 2. Active Learning: Get Next Pair for Comparison via Fisher Information
  fastify.get(
    '/api/pairwise/match',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const allProjects = getProjectsForComparison();

      if (allProjects.length < 2) {
        return reply.code(400).send({ error: 'Not enough projects available for pairwise comparison' });
      }

      const [projectA, projectB] = selectActivePair(allProjects);

      return reply.send({
        project_a: projectA,
        project_b: projectB,
      });
    }
  );

  // 3. Record Pairwise Comparison Decision
  fastify.post<{ Body: PairwiseVoteBody }>(
    '/api/pairwise/vote',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (req: FastifyRequest<{ Body: PairwiseVoteBody }>, reply: FastifyReply) => {
      const { project_a, project_b, winner } = req.body || {};

      if (!project_a || !project_b || !winner) {
        return reply.code(400).send({ error: 'project_a, project_b, and winner are required' });
      }

      if (project_a === project_b) {
        return reply.code(400).send({ error: 'Cannot compare a project to itself' });
      }

      if (!['project_a', 'project_b', 'tie'].includes(winner)) {
        return reply.code(400).send({ error: 'winner must be "project_a", "project_b", or "tie"' });
      }

      const projA = queryOne<{ id: string }>('SELECT id FROM projects WHERE id = ?', project_a);
      const projB = queryOne<{ id: string }>('SELECT id FROM projects WHERE id = ?', project_b);
      if (!projA || !projB) {
        return reply.code(404).send({ error: 'One or both projects not found' });
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

  // 4. Pairwise Judging Interactive HTML View
  fastify.get('/judge/pairwise', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/judge/pairwise&error=Judge+access+required');
    }

    if (req.user.role !== 'judge' && req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — DOGFOOD 2026',
        user: req.user,
        message: `The Pairwise Arena is reserved for registered technical evaluators. Your current active role is ${req.user.role}.`,
      });
    }

    const allProjects = getProjectsForComparison();
    const [projectA, projectB] = selectActivePair(allProjects);
    const ratings = solveBradleyTerry();

    return reply.view('pairwise.ejs', {
      title: 'Pairwise Judging Mode — DOGFOOD 2026',
      user: req.user,
      project_a: projectA,
      project_b: projectB,
      ratings,
    });
  });
}
