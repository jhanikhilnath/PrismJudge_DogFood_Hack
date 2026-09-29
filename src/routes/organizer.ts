import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { requireRole } from '../core/rbac.js';
import { generateCSVExport, generateLeaderboard } from '../engine/ranking.js';
import { computeBayesianNormalization, generateNormalizationProofArtifact } from '../engine/normalization.js';
import { generateBalancedAssignments, getAssignmentStats } from '../engine/assignment.js';
import { getJudgeProgressList, getRecentAuditLogs, getSystemStats } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

export async function organizerRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. CSV Leaderboard Export Endpoint (T2 Check 7 & Multi-Stage Telemetry)
  fastify.get(
    '/api/export.csv',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = (req.query || {}) as { stage?: string };
      const stage = ['composite', 'raw', 'normalized', 'pairwise', 'audit'].includes(query.stage || '')
        ? (query.stage as string)
        : 'composite';

      const csv = generateCSVExport(stage);

      logAuditEvent({
        actorId: req.user!.userId,
        actorRole: req.user!.role,
        action: `CSV_EXPORT_DOWNLOADED_${stage.toUpperCase()}`,
        resourceType: 'export',
        ipAddress: req.ip,
      });

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', `attachment; filename="dogfood-2026-${stage}.csv"`);
      return reply.code(200).send(csv);
    }
  );

  // 1b. Mathematical Normalization Proof Artifact (.txt)
  fastify.get(
    '/api/organizer/normalization-proof.txt',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const proof = generateNormalizationProofArtifact();
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.code(200).send(proof);
    }
  );

  fastify.get(
    '/normalization-proof.txt',
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const proof = generateNormalizationProofArtifact();
      reply.header('Content-Type', 'text/plain; charset=utf-8');
      return reply.code(200).send(proof);
    }
  );

  // 1c. Automated Balanced Workload Assignment APIs
  fastify.post(
    '/api/organizer/assignments/run',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body || {}) as { reviewsPerProject?: number; seed?: number };
      const report = generateBalancedAssignments(body);

      logAuditEvent({
        actorId: req.user!.userId,
        actorRole: req.user!.role,
        action: 'JUDGE_WORKLOAD_ASSIGNED',
        resourceType: 'assignments',
        payload: report,
        ipAddress: req.ip,
      });

      return reply.code(200).send({
        ok: true,
        message: 'Evaluator workloads balanced successfully',
        report,
      });
    }
  );

  fastify.get(
    '/api/organizer/assignments',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      const stats = getAssignmentStats();
      return reply.code(200).send({ stats });
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

  interface AuditQuery {
    actor?: string;
    action?: string;
    resource_type?: string;
    limit?: string;
  }

  // 3. System Audit Trail API with Multi-Parameter Query Filtering
  fastify.get<{ Querystring: AuditQuery }>(
    '/api/organizer/audit',
    {
      preHandler: [requireRole(['organizer', 'admin'])],
    },
    async (req: FastifyRequest<{ Querystring: AuditQuery }>, reply: FastifyReply) => {
      const q = req.query || {};
      const limit = Math.min(1000, parseInt(q.limit || '100', 10) || 100);

      const conditions: string[] = [];
      const params: any[] = [];

      if (q.actor) {
        conditions.push('(actor_id = ? OR actor_role = ?)');
        params.push(q.actor, q.actor);
      }
      if (q.action) {
        conditions.push('action LIKE ?');
        params.push(`%${q.action}%`);
      }
      if (q.resource_type) {
        conditions.push('resource_type = ?');
        params.push(q.resource_type);
      }

      const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const sql = `SELECT id, created_at, actor_id, actor_role, action, resource_type, resource_id, payload, ip_address
                   FROM audit_logs ${whereClause} ORDER BY created_at DESC LIMIT ?`;
      params.push(limit);

      const { queryAll } = await import('../db/index.js');
      const logs = queryAll(sql, ...params);
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
        title: 'Access Restricted — PrismJudge',
        user: req.user,
        message: `The Operations Console is restricted to event administrators and organizers. Your current active role is ${req.user.role}.`,
      });
    }

    const leaderboard = generateLeaderboard();
    const normalization = computeBayesianNormalization();
    const stats = getSystemStats();
    const { getCommunityVotingBreakdown, getEvent } = await import('../db/queries.js');
    const event = getEvent();
    const votingBreakdown = getCommunityVotingBreakdown();

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
      title: 'Organizer Live Dashboard — PrismJudge',
      user: req.user,
      event,
      counts,
      leaderboard,
      normalization,
      judgeProgress,
      underservedProjects,
      recentAuditLogs,
      votingBreakdown,
    });
  });

  // 5. Qualified Teams & Credential Generation Management Console (T4 Bulk Import)
  fastify.get('/organizer/teams', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/organizer/teams&error=Organizer+access+required');
    }

    if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — PrismJudge',
        user: req.user,
        message: 'The Qualified Teams Management console is restricted to organizers and platform administrators.',
      });
    }

    const { getQualifiedTeamsWithCredentials, getAllTracks } = await import('../db/queries.js');
    const teams = getQualifiedTeamsWithCredentials();
    const tracks = getAllTracks();
    const query = req.query as Record<string, string> | undefined;

    return reply.view('organizer_teams.ejs', {
      title: 'Qualified Teams & Credentials — PrismJudge',
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
        if (/^\s*[=+\-@\t\r\|%]/.test(str)) str = `'${str}`;
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
    const { isSafeWebhookUrl } = await import('../core/webhooks.js');
    if (!isSafeWebhookUrl(body.url)) {
      return reply.code(400).send({ error: 'Invalid or restricted webhook URL. Must be public HTTP/HTTPS.' });
    }
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

  // 10. Webhook Delivery Inspection API
  fastify.get('/api/organizer/webhooks/deliveries', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (_req: FastifyRequest, reply: FastifyReply) => {
    const { getRecentWebhookDeliveries } = await import('../core/webhooks.js');
    const deliveries = getRecentWebhookDeliveries(50);
    return reply.code(200).send({ count: deliveries.length, deliveries });
  });

  // 11. Online SQLite Hot Snapshot Backup API
  fastify.post('/api/organizer/backup', {
    preHandler: [requireRole(['organizer', 'admin'])],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { db } = await import('../db/index.js');

    const backupsDir = path.join(process.cwd(), 'backups');
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `dogfood-backup-${timestamp}.sqlite`;
    const targetPath = path.join(backupsDir, filename);

    // Online zero-downtime hot snapshot via SQLite VACUUM INTO
    db.exec(`VACUUM INTO '${targetPath}';`);
    const stats = fs.statSync(targetPath);

    logAuditEvent({
      actorId: req.user!.userId,
      actorRole: req.user!.role,
      action: 'DATABASE_BACKUP_CREATED',
      resourceType: 'backup',
      payload: { filename, sizeBytes: stats.size },
      ipAddress: req.ip,
    });

    return reply.code(200).send({
      ok: true,
      message: 'Hot SQLite database snapshot created successfully',
      filename,
      sizeBytes: stats.size,
      createdAt: new Date().toISOString(),
    });
  });

  // 12. Event Settings & Hackathon Configuration (HTML Console)
  fastify.get('/organizer/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/organizer/settings&error=Organizer+access+required');
    }

    if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — PrismJudge',
        user: req.user,
        message: 'The Event Settings console is restricted to organizers and platform administrators.',
      });
    }

    const { getEvent, getAllTracks } = await import('../db/queries.js');
    const event = getEvent();
    const tracks = getAllTracks();
    const query = req.query as Record<string, string> | undefined;

    // Parse prizes JSON safely
    let prizesList: any[] = [];
    try {
      if (event?.prizes) prizesList = JSON.parse(event.prizes);
    } catch {
      prizesList = [];
    }

    // Parse rubric weights safely
    let rubricWeights = { functionality: 0.4, quality: 0.3, innovation: 0.2, impact: 0.1 };
    try {
      if (event?.rubric_weights) rubricWeights = JSON.parse(event.rubric_weights);
    } catch {
      // fallback
    }

    const configAuditLogs = getRecentAuditLogs(20).filter(
      (l) => l.action.startsWith('EVENT_') || l.action.startsWith('TRACK_')
    );

    return reply.view('organizer_settings.ejs', {
      title: 'Event Settings & Hackathon Configuration — PrismJudge',
      user: req.user,
      event,
      tracks,
      prizesList,
      rubricWeights,
      configAuditLogs,
      saved: query?.saved === '1',
      trackSaved: query?.track_saved === '1',
      trackDeleted: query?.track_deleted === '1',
      error: query?.error || null,
      tab: query?.tab || 'general',
    });
  });

  // 13. Update Event Settings (Form & API) with DOUBLE CONFIRMATION
  fastify.post('/organizer/settings', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/organizer/settings&error=Organizer+access+required');
    }

    if (req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — PrismJudge',
        user: req.user,
        message: 'The Event Settings console is restricted to organizers and platform administrators.',
      });
    }

    const body = (req.body || {}) as Record<string, any>;

    // DOUBLE CONFIRMATION CHECK:
    // Requires confirm_action === 'CONFIRM' or confirmed === true
    const isConfirmed = body.confirm_action === 'CONFIRM' || body.confirmed === true || body.confirmed === '1' || body.confirmed === 'true';
    if (!isConfirmed) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(400).send({
          error: 'Double confirmation required',
          message: 'Critical event configuration changes require explicit double confirmation.',
        });
      }
      return reply.redirect('/organizer/settings?error=Double+confirmation+required.+Type+CONFIRM+to+authorize+changes.');
    }

    const { getEvent, updateEventSettings } = await import('../db/queries.js');
    const currentEvent = getEvent();
    if (!currentEvent) {
      return reply.code(500).send({ error: 'No event record found' });
    }

    // Process Rubric Weights
    let rubricWeightsStr = currentEvent.rubric_weights;
    if (body.weight_func !== undefined && body.weight_qual !== undefined) {
      const func = parseFloat(body.weight_func) || 0.4;
      const qual = parseFloat(body.weight_qual) || 0.3;
      const inno = parseFloat(body.weight_inno) || 0.2;
      const imp = parseFloat(body.weight_imp) || 0.1;
      rubricWeightsStr = JSON.stringify({ functionality: func, quality: qual, innovation: inno, impact: imp });
    } else if (body.rubric_weights) {
      rubricWeightsStr = typeof body.rubric_weights === 'string' ? body.rubric_weights : JSON.stringify(body.rubric_weights);
    }

    // Process Prizes
    let prizesStr = currentEvent.prizes;
    if (body.prizes_json) {
      prizesStr = typeof body.prizes_json === 'string' ? body.prizes_json : JSON.stringify(body.prizes_json);
    }

    const updates: Record<string, any> = {};
    if (body.name) updates.name = String(body.name).trim();
    if (body.tagline !== undefined) updates.tagline = String(body.tagline).trim();
    if (body.description !== undefined) updates.description = String(body.description).trim();
    if (body.submissions_open) updates.submissions_open = String(body.submissions_open).trim();
    if (body.submissions_close) updates.submissions_close = String(body.submissions_close).trim();
    if (body.judging_open) updates.judging_open = String(body.judging_open).trim();
    if (body.judging_close) updates.judging_close = String(body.judging_close).trim();
    if (body.voting_open) updates.voting_open = String(body.voting_open).trim();
    if (body.voting_close) updates.voting_close = String(body.voting_close).trim();
    if (body.results_announced_at) updates.results_announced_at = String(body.results_announced_at).trim();
    if (body.prize_pool !== undefined) updates.prize_pool = String(body.prize_pool).trim();
    if (prizesStr) updates.prizes = prizesStr;
    if (rubricWeightsStr) updates.rubric_weights = rubricWeightsStr;
    if (body.min_reviews_per_project !== undefined) updates.min_reviews_per_project = parseInt(body.min_reviews_per_project, 10) || 3;
    if (body.max_team_size !== undefined) updates.max_team_size = parseInt(body.max_team_size, 10) || 4;
    if (body.require_repo_url !== undefined) updates.require_repo_url = body.require_repo_url === '1' || body.require_repo_url === true || body.require_repo_url === 'on' ? 1 : 0;
    if (body.require_demo_url !== undefined) updates.require_demo_url = body.require_demo_url === '1' || body.require_demo_url === true || body.require_demo_url === 'on' ? 1 : 0;
    if (body.voting_mode) updates.voting_mode = String(body.voting_mode).trim();
    if (body.prevent_self_voting !== undefined) updates.prevent_self_voting = body.prevent_self_voting === '0' || body.prevent_self_voting === false ? 0 : 1;
    if (body.pairwise_enabled !== undefined) updates.pairwise_enabled = body.pairwise_enabled === '0' || body.pairwise_enabled === false ? 0 : 1;
    if (body.voting_results_published !== undefined) updates.voting_results_published = body.voting_results_published === '1' || body.voting_results_published === true || body.voting_results_published === 'on' ? 1 : 0;
    if (body.results_published !== undefined) updates.results_published = body.results_published === '1' || body.results_published === true || body.results_published === 'on' ? 1 : 0;

    // Compute diff for immutable audit logging
    const diff: Record<string, { from: any; to: any }> = {};
    for (const [k, newVal] of Object.entries(updates)) {
      const oldVal = (currentEvent as any)[k];
      if (String(oldVal) !== String(newVal)) {
        diff[k] = { from: oldVal, to: newVal };
      }
    }

    updateEventSettings(updates);

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'EVENT_SETTINGS_UPDATED',
      resourceType: 'events',
      resourceId: currentEvent.id,
      payload: {
        changedFields: Object.keys(diff),
        diff,
        confirmedBy: req.user.userId,
        timestamp: new Date().toISOString(),
      },
      ipAddress: req.ip,
    });

    if (req.headers.accept?.includes('application/json')) {
      return reply.code(200).send({
        ok: true,
        message: 'Event settings updated successfully with audit trail recording',
        changes: Object.keys(diff),
        event: getEvent(),
      });
    }

    return reply.redirect('/organizer/settings?saved=1');
  });

  // 14. Save/Update Track with Double Confirmation
  fastify.post('/api/organizer/tracks/save', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = (req.body || {}) as { id?: string; name?: string; description?: string; prize_amount?: string; confirm_action?: string };

    if (body.confirm_action !== 'CONFIRM') {
      return reply.code(400).send({ error: 'Track configuration modification requires typing CONFIRM' });
    }

    if (!body.name || !body.name.trim()) {
      return reply.code(400).send({ error: 'Track name is required' });
    }

    const { saveTrack } = await import('../db/queries.js');
    const trackId = body.id && body.id.trim() ? body.id.trim() : `trk_${Date.now().toString(36)}`;
    saveTrack(trackId, body.name.trim(), (body.description || '').trim(), (body.prize_amount || '$500').trim());

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'TRACK_SAVED',
      resourceType: 'tracks',
      resourceId: trackId,
      payload: { name: body.name, prize_amount: body.prize_amount },
      ipAddress: req.ip,
    });

    return reply.code(200).send({ ok: true, trackId, message: 'Track saved successfully' });
  });

  // 15. Delete Track with Double Confirmation & Project Collision Check
  fastify.post('/api/organizer/tracks/delete', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const body = (req.body || {}) as { id: string; confirm_action?: string };

    if (body.confirm_action !== 'CONFIRM') {
      return reply.code(400).send({ error: 'Track deletion requires typing CONFIRM' });
    }

    const { deleteTrack } = await import('../db/queries.js');
    const result = deleteTrack(body.id);
    if (!result.success) {
      return reply.code(400).send({ error: result.error });
    }

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'TRACK_DELETED',
      resourceType: 'tracks',
      resourceId: body.id,
      payload: { trackId: body.id },
      ipAddress: req.ip,
    });

    return reply.code(200).send({ ok: true, message: 'Track deleted successfully' });
  });

  // 16. Toggle Results Portal Publication (/results)
  fastify.post('/api/organizer/results/toggle', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const { getEvent, toggleResultsPublished } = await import('../db/queries.js');
    const ev = getEvent();
    const body = (req.body || {}) as { published?: boolean | string };
    
    let targetState: boolean;
    if (body.published !== undefined) {
      targetState = body.published === true || body.published === '1' || body.published === 'true';
    } else {
      targetState = ev?.results_published !== 1;
    }

    toggleResultsPublished(targetState);

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'RESULTS_PUBLICATION_TOGGLED',
      resourceType: 'events',
      resourceId: ev?.id || 'evt_01',
      payload: { results_published: targetState ? 1 : 0 },
      ipAddress: req.ip,
    });

    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      const redirectUrl = (req.headers.referer as string) || '/organizer/dashboard';
      return reply.redirect(redirectUrl);
    }

    return reply.code(200).send({
      ok: true,
      results_published: targetState ? 1 : 0,
      message: targetState ? 'Results portal successfully published to the public' : 'Results portal embargoed (hidden from public)'
    });
  });

  // 17. Toggle Community Choice Voting Standings Publication
  fastify.post('/api/organizer/voting-results/toggle', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.code(403).send({ error: 'Forbidden' });
    }

    const { getEvent, toggleVotingResultsPublished } = await import('../db/queries.js');
    const ev = getEvent();
    const body = (req.body || {}) as { published?: boolean | string };
    
    let targetState: boolean;
    if (body.published !== undefined) {
      targetState = body.published === true || body.published === '1' || body.published === 'true';
    } else {
      targetState = ev?.voting_results_published !== 1;
    }

    toggleVotingResultsPublished(targetState);

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'VOTING_RESULTS_PUBLICATION_TOGGLED',
      resourceType: 'events',
      resourceId: ev?.id || 'evt_01',
      payload: { voting_results_published: targetState ? 1 : 0 },
      ipAddress: req.ip,
    });

    if (req.headers['content-type']?.includes('application/x-www-form-urlencoded')) {
      const redirectUrl = (req.headers.referer as string) || '/organizer/dashboard';
      return reply.redirect(redirectUrl);
    }

    return reply.code(200).send({
      ok: true,
      voting_results_published: targetState ? 1 : 0,
      message: targetState ? 'Community voting standings successfully published' : 'Community voting standings sealed'
    });
  });
}

