import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { enforceJudgePeerIsolation, requireRole, resolveJudgeAlias } from '../core/rbac.js';
import { execute, getAllTracks, getJudgeScores, getProjectsForComparison, queryOne, ScoreRecord } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';
import { calculateWeightedScore } from '../engine/normalization.js';
import { hasConflictOfInterest, markAssignmentCompleted, getAssignmentsForJudge } from '../engine/assignment.js';

interface JudgeScoresQuery {
  judge?: string;
  judge_id?: string;
  project_id?: string;
}

interface SubmitScoreBody {
  project_id?: string;
  criteria?: Record<string, number>;
  scores?: Record<string, number>;
  comment?: string;
}

export async function judgingRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. Judge Scores API (T2 Checks 4, 5, 6: Peer Isolation & Score Inspection)
  fastify.get<{ Querystring: JudgeScoresQuery }>(
    '/api/judge/scores',
    {
      preHandler: [enforceJudgePeerIsolation],
    },
    async (req: FastifyRequest<{ Querystring: JudgeScoresQuery }>, reply: FastifyReply) => {
      // Access control verified by enforceJudgePeerIsolation:
      // - Authenticated: 200/403
      // - Participant: blocked with 403
      // - Peer judge snooping: blocked with 403
      const currentUser = req.user!;
      const query = req.query || {};

      let targetJudgeId = currentUser.userId;
      if (currentUser.role === 'organizer' || currentUser.role === 'admin') {
        const requestedJudge = query.judge || query.judge_id;
        if (requestedJudge) {
          targetJudgeId = resolveJudgeAlias(requestedJudge);
        }
      }

      const scores = getJudgeScores(targetJudgeId, query.project_id);

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

  // 2. Submit / Update Rubric Score (T2: Weighted 4-Criterion Evaluation)
  fastify.post<{ Body: SubmitScoreBody }>(
    '/api/judge/scores',
    {
      preHandler: [requireRole(['judge', 'organizer', 'admin'])],
    },
    async (req: FastifyRequest<{ Body: SubmitScoreBody }>, reply: FastifyReply) => {
      const body = req.body || {};
      const criteria = body.criteria || body.scores;
      const { project_id, comment } = body;

      if (!project_id || !criteria || typeof criteria !== 'object') {
        return reply.code(400).send({ error: 'project_id and criteria object are required' });
      }

      const project = queryOne<{ id: string }>('SELECT id FROM projects WHERE id = ?', project_id);
      if (!project) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      // Validate criteria values: must be numbers between 1 and 5
      for (const [key, val] of Object.entries(criteria)) {
        const num = Number(val);
        if (isNaN(num) || num < 1 || num > 5) {
          return reply.code(400).send({ error: `Criteria ${key} must be a number between 1 and 5` });
        }
      }

      const rawTotal = calculateWeightedScore(criteria);
      const judgeId = req.user!.userId;

      // Conflict of Interest (COI) Defense
      if (hasConflictOfInterest(judgeId, project_id)) {
        return reply.code(403).send({
          error: 'ConflictOfInterest',
          message: 'Conflict of Interest: Evaluators are strictly prohibited from scoring submissions belonging to their own team.',
        });
      }

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
        comment ? String(comment).trim() : null,
        now
      );

      // Mark assignment completed if assigned
      markAssignmentCompleted(judgeId, project_id);

      logAuditEvent({
        actorId: judgeId,
        actorRole: req.user!.role,
        action: 'SCORE_SUBMITTED',
        resourceType: 'score',
        resourceId: scoreId,
        payload: { project_id, rawTotal, criteria, comment },
        ipAddress: req.ip,
      });

      return reply.code(200).send({
        message: 'Score submitted successfully',
        scoreId,
        project_id,
        raw_total: rawTotal,
        criteria,
        comment: comment ? String(comment).trim() : null,
      });
    }
  );

  // 3. Judge Dashboard (T2: Assigned Workload Queue & Real-Time Scoring)
  fastify.get('/judge/dashboard', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) {
      return reply.redirect('/login?redirect=/judge/dashboard&error=Judge+or+Organizer+access+required');
    }

    if (req.user.role !== 'judge' && req.user.role !== 'organizer' && req.user.role !== 'admin') {
      return reply.code(403).view('403.ejs', {
        title: 'Access Restricted — DOGFOOD 2026',
        user: req.user,
        message: `The Judging Dashboard is reserved for registered technical evaluators. Your current active role is ${req.user.role}.`,
      });
    }

    const judgeId = req.user.userId;
    const scores = getJudgeScores(judgeId);
    const scoredProjectIds = new Set(scores.map((s) => s.project_id));
    const allProjects = getProjectsForComparison();
    const tracks = getAllTracks();

    const scoreMap = new Map<string, ScoreRecord>(scores.map((s) => [s.project_id, s]));
    const judgeAssignments = getAssignmentsForJudge(judgeId);
    const assignedProjectIds = new Set(judgeAssignments.map((a) => a.projectId));

    const assigned = allProjects.map((p) => ({
      ...p,
      hasScored: scoredProjectIds.has(p.id),
      score: scoreMap.get(p.id),
      isDirectlyAssigned: assignedProjectIds.size > 0 ? assignedProjectIds.has(p.id) : true,
    }));

    // If balanced assignments exist, sort directly assigned items first
    if (assignedProjectIds.size > 0) {
      assigned.sort((a, b) => {
        if (a.isDirectlyAssigned !== b.isDirectlyAssigned) {
          return a.isDirectlyAssigned ? -1 : 1;
        }
        if (a.hasScored !== b.hasScored) {
          return a.hasScored ? 1 : -1;
        }
        return a.title.localeCompare(b.title);
      });
    }

    return reply.view('judge_dashboard.ejs', {
      title: 'Judge Evaluation Dashboard — DOGFOOD 2026',
      user: req.user,
      assigned,
      tracks,
      completedCount: scores.length,
      totalAssigned: assignedProjectIds.size > 0 ? assignedProjectIds.size : allProjects.length,
      assignments: judgeAssignments,
    });
  });
}
