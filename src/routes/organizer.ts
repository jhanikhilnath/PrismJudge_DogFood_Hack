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

  // 5. Qualified Teams & Credential Generation Management Console (T4 Bulk Import)
  fastify.get('/organizer/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/organizer/teams&error=Organizer+access+required');
    }

    if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — DOGFOOD 2026',
        user: req.user,
        message: 'The Qualified Teams Management console is restricted to organizers and platform administrators.',
      });
    }

    const { getQualifiedTeamsWithCredentials, getAllTracks } = await import('../db/queries.js');
    const teams = getQualifiedTeamsWithCredentials();
    const tracks = getAllTracks();
    const query = req.query as Record<string, string> | undefined;

    return reply.view('organizer_teams.ejs', {
      title: 'Qualified Teams & Credentials — DOGFOOD 2026',
      user: req.user,
      teams,
      tracks,
      created: query?.created === '1',
      imported: query?.imported ? parseInt(query.imported, 10) : null,
    });
  });

  // 6. Create Single Qualified Team (Form POST)
  fastify.post('/organizer/teams', async (req: FastifyRequest<{
    Body: {
      teamName: string;
      trackId?: string;
      projectTitle?: string;
      leaderName: string;
      leaderEmail: string;
      customPassword?: string;
    };
  }>, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = req.body;
    if (!body || !body.teamName || !body.leaderEmail) {
      return reply.redirect('/organizer/teams?error=Missing+required+team+name+or+leader+email');
    }

    const { createQualifiedTeam } = await import('../db/queries.js');
    createQualifiedTeam({
      teamName: body.teamName,
      trackId: body.trackId,
      projectTitle: body.projectTitle,
      leaderName: body.leaderName || body.teamName,
      leaderEmail: body.leaderEmail,
      customPassword: body.customPassword,
    });

    return reply.redirect('/organizer/teams?created=1');
  });

  // 7. Bulk Import Qualified Teams API (JSON or CSV)
  fastify.post<{
    Body: {
      csvText?: string;
      teams?: Array<{
        teamName: string;
        trackId?: string;
        projectTitle?: string;
        leaderName?: string;
        leaderEmail: string;
      }>;
    };
  }>('/api/organizer/teams/import', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (req, reply: FastifyReply) => {
    const { bulkImportQualifiedTeams, getAllTracks } = await import('../db/queries.js');
    const body = req.body || {};
    let rowsToImport: Array<{ teamName: string; trackId?: string; projectTitle?: string; leaderName: string; leaderEmail: string }> = [];

    if (Array.isArray(body.teams)) {
      rowsToImport = body.teams.map((t) => ({
        teamName: t.teamName,
        trackId: t.trackId,
        projectTitle: t.projectTitle,
        leaderName: t.leaderName || t.teamName,
        leaderEmail: t.leaderEmail,
      }));
    } else if (body.csvText && typeof body.csvText === 'string') {
      const tracks = getAllTracks();
      const trackMap = new Map(tracks.map((t) => [t.name.toLowerCase(), t.id]));

      const lines = body.csvText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
      for (const line of lines) {
        if (line.toLowerCase().startsWith('team name') || line.toLowerCase().startsWith('team_name')) continue;
        const parts = line.split(',').map((p) => p.trim());
        if (parts.length >= 2) {
          const teamName = parts[0];
          const rawTrack = parts[1] || '';
          const matchedTrack = trackMap.get(rawTrack.toLowerCase()) || rawTrack;
          const projectTitle = parts[2] || '';
          const leaderName = parts[3] || teamName;
          const leaderEmail = parts[4] || (parts[1].includes('@') ? parts[1] : `${teamName.toLowerCase().replace(/[^a-z0-9]/g, '')}@dogfood.test`);

          rowsToImport.push({
            teamName,
            trackId: matchedTrack,
            projectTitle,
            leaderName,
            leaderEmail,
          });
        }
      }
    }

    if (rowsToImport.length === 0) {
      return reply.code(400).send({ error: 'No valid team records found to import' });
    }

    const imported = bulkImportQualifiedTeams(rowsToImport);

    logAuditEvent({
      actorId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'BULK_TEAMS_IMPORTED',
      resourceType: 'teams',
      payload: { count: imported.length },
      ipAddress: req.ip,
    });

    return reply.send({ success: true, count: imported.length, imported });
  });

  // 8. Download Generated Credentials as CSV
  fastify.get('/api/organizer/teams/credentials.csv', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const { getQualifiedTeamsWithCredentials } = await import('../db/queries.js');
    const teams = getQualifiedTeamsWithCredentials();
    const config = (await import('../config.js')).config;

    logAuditEvent({
      actorId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'CREDENTIALS_CSV_DOWNLOADED',
      resourceType: 'credentials',
      payload: { count: teams.length },
      ipAddress: req.ip,
    });

    const headers = ['team_id', 'team_name', 'track_name', 'user_id', 'leader_name', 'leader_email', 'temporary_password', 'login_url'];
    const rows = [headers.join(',')];

    for (const t of teams) {
      const escape = (val: string | null | undefined) => {
        if (!val) return '""';
        let str = String(val);
        if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
        return `"${str.replace(/"/g, '""')}"`;
      };

      rows.push([
        escape(t.team_id),
        escape(t.team_name),
        escape(t.track_name || 'General'),
        escape(t.user_id || 'N/A'),
        escape(t.leader_name || 'Team Lead'),
        escape(t.leader_email || ''),
        escape(t.temporary_password || 'Seeded / Existing'),
        escape(`${config.baseUrl}/login`),
      ].join(','));
    }

    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="qualified_teams_credentials.csv"');
    return reply.code(200).send(rows.join('\r\n'));
  });

  // 9. Webhook Registration & Dispatch APIs (T4 Webhooks)
  fastify.get('/api/organizer/webhooks', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const { getWebhooks } = await import('../db/queries.js');
    return reply.send({ webhooks: getWebhooks() });
  });

  fastify.post<{ Body: { url: string; eventTypes?: string; secret?: string } }>('/api/organizer/webhooks', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (req, reply: FastifyReply) => {
    const body = req.body;
    if (!body || !body.url) return reply.code(400).send({ error: 'Webhook URL is required' });
    const { createWebhook } = await import('../db/queries.js');
    const id = createWebhook(body.url, body.eventTypes || 'all', body.secret);

    logAuditEvent({
      actorId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'WEBHOOK_CREATED',
      resourceType: 'webhook',
      resourceId: id,
      payload: { url: body.url },
      ipAddress: req.ip,
    });

    return reply.code(201).send({ success: true, id, message: 'Webhook registered successfully' });
  });

  fastify.delete<{ Params: { id: string } }>('/api/organizer/webhooks/:id', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (req, reply: FastifyReply) => {
    const { deleteWebhook } = await import('../db/queries.js');
    const deleted = deleteWebhook(req.params.id);

    logAuditEvent({
      actorId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'WEBHOOK_DELETED',
      resourceType: 'webhook',
      resourceId: req.params.id,
      payload: { success: deleted },
      ipAddress: req.ip,
    });

    return reply.send({ success: deleted });
  });
}
