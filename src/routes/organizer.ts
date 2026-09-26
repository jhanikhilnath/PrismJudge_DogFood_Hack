import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../core/rbac.js';
import { generateCSVExport, generateLeaderboard } from '../engine/ranking.js';
import { computeBayesianNormalization } from '../engine/normalization.js';
import { queryAll, queryOne } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

export async function organizerRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Check 7: CSV Export Endpoint
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

  // Live Normalization Stats API
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

  // Audit Trail API
  fastify.get(
    '/api/organizer/audit',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const logs = queryAll('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100');
      return reply.send({ count: logs.length, logs });
    }
  );

  // Organizer Dashboard (HTML)
  fastify.get('/organizer/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.redirect('/api/auth/switch/organizer?redirect=/organizer/dashboard');
    }

    const leaderboard = generateLeaderboard();
    const normalization = computeBayesianNormalization();

    const counts = {
      projects: (queryOne<{ c: number }>('SELECT count(*) as c FROM projects')?.c) || 0,
      judges: (queryOne<{ c: number }>('SELECT count(*) as c FROM users WHERE role = "judge"')?.c) || 0,
      scores: (queryOne<{ c: number }>('SELECT count(*) as c FROM scores')?.c) || 0,
      votes: (queryOne<{ c: number }>('SELECT count(*) as c FROM community_votes')?.c) || 0,
    };

    // Review completion progress per judge
    const judgeProgress = queryAll<{ id: string; name: string; email: string; reviews: number }>(`
      SELECT 
        u.id, 
        u.name, 
        u.email,
        (SELECT COUNT(*) FROM scores s WHERE s.judge_id = u.id) as reviews
      FROM users u
      WHERE u.role = 'judge'
      ORDER BY reviews ASC, u.name ASC
    `);

    // Projects with fewest reviews
    const underservedProjects = leaderboard.filter((p) => p.reviewCount < 3);

    return reply.view('organizer_dash.ejs', {
      title: 'Organizer Live Dashboard — DOGFOOD 2026',
      user: req.user,
      counts,
      leaderboard,
      normalization,
      judgeProgress,
      underservedProjects,
    });
  });
}
