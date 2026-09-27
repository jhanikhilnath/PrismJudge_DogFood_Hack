import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../core/rbac.js';
import { generateCSVExport, generateLeaderboard } from '../engine/ranking.js';
import { computeBayesianNormalization } from '../engine/normalization.js';
import { getJudgeProgressList, getRecentAuditLogs, getSystemStats } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

export async function organizerRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. CSV Leaderboard Export Endpoint (T2 Check 7)
  fastify.get(
    '/api/export.csv',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const csv = generateCSVExport();

      logAuditEvent({
        actorId: req.user!.userId,
        actorRole: req.user!.role,
        action: 'CSV_EXPORT_DOWNLOADED',
        resourceType: 'export',
        ipAddress: req.ip,
      });

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="dogfood-2026-results.csv"');
      return reply.code(200).send(csv);
    }
  );

  // 2. Bayesian Normalization Telemetry API
  fastify.get(
    '/api/organizer/normalization',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const stats = computeBayesianNormalization();
      return reply.send(stats);
    }
  );

  // 3. System Audit Trail API
  fastify.get(
    '/api/organizer/audit',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const logs = getRecentAuditLogs(100);
      return reply.send({ count: logs.length, logs });
    }
  );

  // 4. Operations Console (HTML)
  fastify.get('/organizer/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/organizer/dashboard&error=Organizer+access+required');
    }

    if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — DOGFOOD 2026',
        user: req.user,
        message: `The Operations Console is restricted to event administrators and organizers. Your current active role is ${req.user.role}.`,
      });
    }

    const leaderboard = generateLeaderboard();
    const normalization = computeBayesianNormalization();
    const stats = getSystemStats();

    const counts = {
      projects: stats.projectCount,
      judges: stats.judgeCount,
      scores: stats.scoreCount,
      votes: stats.voteCount,
    };

    const judgeProgress = getJudgeProgressList();
    const underservedProjects = leaderboard.filter((p) => p.reviewCount < 3);
    const recentAuditLogs = getRecentAuditLogs(15);

    return reply.view('organizer_dash.ejs', {
      title: 'Organizer Live Dashboard — DOGFOOD 2026',
      user: req.user,
      counts,
      leaderboard,
      normalization,
      judgeProgress,
      underservedProjects,
      recentAuditLogs,
    });
  });
}
