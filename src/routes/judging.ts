import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { enforceJudgePeerIsolation, requireRole } from '../core/rbac.js';
import { queryAll, queryOne, execute } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

interface ScoreDetails {
  id: string;
  judge_id: string;
  project_id: string;
  project_title: string;
  criteria: any;
  raw_total: number;
  comment: string | null;
  submitted_at: string;
}

export async function judgingRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Judge Scores API (Checks 4, 5, 6)
  fastify.get(
    '/api/judge/scores',
    {
      preHandler: [enforceJudgePeerIsolation],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      // At this point, enforceJudgePeerIsolation has already verified:
      // 1. User is authenticated (or 401)
      // 2. User is not a participant (or 403)
      // 3. User is not snooping on another judge (or 403)
      const currentUser = req.user!;
      const query = req.query as { judge?: string; judge_id?: string; project_id?: string };

      // Determine which judge's scores to query
      let targetJudgeId = currentUser.userId;

      // Organizer or admin can inspect any judge
      if (currentUser.role === 'organizer' || currentUser.role === 'admin') {
        if (query.judge) {
          if (query.judge === 'judge_a') targetJudgeId = 'jdg_01';
          else if (query.judge === 'judge_b') targetJudgeId = 'jdg_02';
          else targetJudgeId = query.judge;
        }
      }

      let sql = `
        SELECT 
          s.id,
          s.judge_id,
          s.project_id,
          p.title as project_title,
          s.criteria,
          s.raw_total,
          s.comment,
          s.submitted_at
        FROM scores s
        JOIN projects p ON s.project_id = p.id
        WHERE s.judge_id = ?
      `;

      const params: any[] = [targetJudgeId];
      if (query.project_id) {
        sql += ' AND s.project_id = ?';
        params.push(query.project_id);
      }

      sql += ' ORDER BY s.submitted_at DESC';

      const scores = queryAll<ScoreDetails>(sql, ...params);

      // Parse JSON criteria for clean response
      const parsedScores = scores.map((s) => ({
        ...s,
        criteria: typeof s.criteria === 'string' ? JSON.parse(s.criteria) : s.criteria,
      }));

      return reply.code(200).send({
        judge_id: targetJudgeId,
        count: parsedScores.length,
        scores: parsedScores,
      });
    }
  );

  // Submit / update score
  fastify.post(
    '/api/judge/scores',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const body = (req.body as any) || {};
      const { project_id, criteria, comment } = body;

      if (!project_id || !criteria || typeof criteria !== 'object') {
        return reply.code(400).send({ error: 'project_id and criteria object are required' });
      }

      const project = queryOne<{ id: string }>('SELECT id FROM projects WHERE id = ?', project_id);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      const event = queryOne<{ rubric_weights: string }>('SELECT rubric_weights FROM events LIMIT 1');
      let weights: Record<string, number> = { functionality: 0.4, quality: 0.3, innovation: 0.3 };
      if (event?.rubric_weights) {
        try {
          weights = JSON.parse(event.rubric_weights);
        } catch {}
      }

      let rawTotal = 0;
      for (const [k, w] of Object.entries(weights)) {
        if (criteria[k] !== undefined) {
          rawTotal += Number(criteria[k]) * w;
        }
      }

      const judgeId = req.user!.userId;
      const scoreId = `sc_${judgeId}_${project_id}`;
      const now = new Date().toISOString();

      execute(
        `INSERT OR REPLACE INTO scores (id, judge_id, project_id, criteria, raw_total, comment, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        scoreId,
        judgeId,
        project_id,
        JSON.stringify(criteria),
        rawTotal,
        comment || null,
        now
      );

      logAuditEvent({
        actorId: judgeId,
        actorRole: req.user!.role,
        action: 'SCORE_SUBMITTED',
        resourceType: 'score',
        resourceId: scoreId,
        payload: { project_id, rawTotal, criteria },
        ipAddress: req.ip,
      });

      return reply.code(200).send({
        message: 'Score submitted successfully',
        scoreId,
        rawTotal,
        submitted_at: now,
      });
    }
  );

  // Judge Dashboard (HTML)
  fastify.get('/judge/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user || (req.user.role !== 'judge' && req.user.role !== 'organizer' && req.user.role !== 'admin')) {
      return reply.redirect('/api/auth/switch/judge_a?redirect=/judge/dashboard');
    }

    const judgeId = req.user.userId;
    const scores = queryAll<ScoreDetails>(
      `SELECT 
        s.id,
        s.judge_id,
        s.project_id,
        p.title as project_title,
        s.criteria,
        s.raw_total,
        s.comment,
        s.submitted_at
      FROM scores s
      JOIN projects p ON s.project_id = p.id
      WHERE s.judge_id = ?`,
      judgeId
    );

    const scoredProjectIds = new Set(scores.map((s) => s.project_id));
    const allProjects = queryAll<{ id: string; title: string; track_name: string; summary: string }>(`
      SELECT p.id, p.title, tr.name as track_name, p.summary
      FROM projects p
      LEFT JOIN tracks tr ON p.track_id = tr.id
      ORDER BY p.id ASC
    `);

    const assigned = allProjects.map((p) => ({
      ...p,
      hasScored: scoredProjectIds.has(p.id),
      score: scores.find((s) => s.project_id === p.id),
    }));

    return reply.view('judge_dashboard.ejs', {
      title: 'Judge Evaluation Dashboard — DOGFOOD 2026',
      user: req.user,
      assigned,
      completedCount: scores.length,
      totalAssigned: allProjects.length,
    });
  });
}
