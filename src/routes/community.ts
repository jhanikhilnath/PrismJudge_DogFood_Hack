import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { queryAll, queryOne, execute } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

// Sliding-window rate limiter in memory (resets on server restart, complemented by SQLite unique constraint)
const voteRateLimitWindow = new Map<string, number>();

export async function communityRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Public Community Voting View (T3: Randomized Ballots & Hidden Results)
  fastify.get('/vote', async (req: FastifyRequest, reply: FastifyReply) => {
    const event = queryOne<{ id: string; name: string; voting_close: string | null }>(
      'SELECT id, name, voting_close FROM events LIMIT 1'
    );

    const now = new Date().toISOString();
    const isVotingClosed = event?.voting_close ? now > event.voting_close : false;

    // Fetch projects
    const projects = queryAll<{ id: string; title: string; track_name: string; summary: string }>(`
      SELECT p.id, p.title, tr.name as track_name, p.summary
      FROM projects p
      LEFT JOIN tracks tr ON p.track_id = tr.id
      WHERE p.is_draft = 0
    `);

    // Randomized ballot ordering: deterministic per visitor session to eliminate presentation order bias
    const seed = req.user?.token || req.ip || 'default_seed';
    const shuffled = [...projects].sort((a, b) => {
      const hashA = crypto.createHash('md5').update(`${seed}_${a.id}`).digest('hex');
      const hashB = crypto.createHash('md5').update(`${seed}_${b.id}`).digest('hex');
      return hashA.localeCompare(hashB);
    });

    // Check if user already voted
    let userVotedProjectId: string | null = null;
    if (req.user) {
      const existing = queryOne<{ project_id: string }>(
        'SELECT project_id FROM community_votes WHERE voter_hash = ? LIMIT 1',
        req.user.userId
      );
      if (existing) userVotedProjectId = existing.project_id;
    }

    return reply.view('voting.ejs', {
      title: 'Community Voting — DOGFOOD 2026',
      projects: shuffled,
      event,
      user: req.user,
      isVotingClosed,
      userVotedProjectId,
    });
  });

  // Cast Community Vote (Anti-Abuse, Rate Limited, Unique)
  fastify.post('/api/vote', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body as any) || {};
    const { project_id, voter_email } = body;

    if (!project_id) {
      return reply.code(400).send({ error: 'project_id is required' });
    }

    const ip = req.ip || '127.0.0.1';
    const voterIdentifier = req.user ? req.user.userId : voter_email ? voter_email.toLowerCase().trim() : ip;
    const voterHash = crypto.createHash('sha256').update(voterIdentifier).digest('hex').substring(0, 16);
    const ipHash = crypto.createHash('sha256').update(ip).digest('hex').substring(0, 16);

    // Rate limit check: max 1 vote attempt per 3 seconds per IP
    const now = Date.now();
    const lastVote = voteRateLimitWindow.get(ip) || 0;
    if (now - lastVote < 3000) {
      return reply.code(429).send({ error: 'Too many requests. Please wait a few seconds before voting.' });
    }
    voteRateLimitWindow.set(ip, now);

    // Verify project exists
    const proj = queryOne<{ id: string }>('SELECT id FROM projects WHERE id = ?', project_id);
    if (!proj) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Check for duplicate vote
    const existing = queryOne<{ id: string }>(
      'SELECT id FROM community_votes WHERE project_id = ? AND voter_hash = ?',
      project_id,
      voterHash
    );

    if (existing) {
      return reply.code(409).send({ error: 'You have already voted for this project' });
    }

    const voteId = `vt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    execute(
      `INSERT INTO community_votes (id, project_id, voter_hash, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      voteId,
      project_id,
      voterHash,
      ipHash,
      new Date().toISOString()
    );

    logAuditEvent({
      actorId: req.user ? req.user.userId : voterHash,
      actorRole: req.user ? req.user.role : 'community_voter',
      action: 'COMMUNITY_VOTE_CAST',
      resourceType: 'community_vote',
      resourceId: voteId,
      payload: { project_id },
      ipAddress: ip,
    });

    return reply.code(200).send({
      message: 'Vote recorded successfully',
      voteId,
      project_id,
    });
  });

  // Post comment
  fastify.post('/api/comments/:projectId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const body = (req.body as any) || {};
    const { content, author_name } = body;

    if (!content || !content.trim()) {
      return reply.code(400).send({ error: 'Comment content cannot be empty' });
    }

    const name = req.user?.name || author_name?.trim() || 'Anonymous Visitor';
    const commentId = `cm_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const now = new Date().toISOString();

    execute(
      `INSERT INTO comments (id, project_id, user_id, author_name, content, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      commentId,
      projectId,
      req.user ? req.user.userId : null,
      name,
      content.trim().substring(0, 1000),
      now
    );

    if (req.headers.accept?.includes('text/html') || !req.headers['content-type']?.includes('application/json')) {
      return reply.redirect(`/projects/${projectId}`);
    }

    return reply.code(201).send({
      message: 'Comment posted',
      comment: { id: commentId, project_id: projectId, author_name: name, content: content.trim(), created_at: now },
    });
  });
}
