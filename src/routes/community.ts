import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { execute, getAllTracks, getEvent, getProjectsForComparison, isVotingClosed, queryAll, queryOne } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';
import { rateLimit } from '../core/rateLimit.js';

// Sliding-window rate limiter in memory (resets on server restart, complemented by SQLite unique constraint)
const voteRateLimitWindow = new Map<string, number>();

interface CommunityVoteBody {
  project_id?: string;
  voter_email?: string;
}

interface CommentBody {
  content?: string;
  author_name?: string;
}

/**
 * Hash voter identifier to a privacy-preserving 16-character hexadecimal digest.
 */
function hashVoterIdentifier(identifier: string): string {
  return crypto.createHash('sha256').update(identifier).digest('hex').substring(0, 16);
}

export async function communityRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. Public Community Voting View (T3: Randomized Ballots & Presentation Debiasing)
  fastify.get('/vote', async (req: FastifyRequest, reply: FastifyReply) => {
    const event = getEvent();
    const votingClosed = isVotingClosed(event);
    const projects = getProjectsForComparison();
    const tracks = getAllTracks();

    // Deterministic Fisher-Yates hash shuffle per visitor session to eliminate presentation order bias
    const seed = req.user?.token || req.ip || 'default_seed';
    const shuffled = [...projects].sort((a, b) => {
      const hashA = crypto.createHash('md5').update(`${seed}_${a.id}`).digest('hex');
      const hashB = crypto.createHash('md5').update(`${seed}_${b.id}`).digest('hex');
      return hashA.localeCompare(hashB);
    });

    const userVotedProjectIds: string[] = [];
    let userTeamProjectId: string | null = null;
    if (req.user) {
      const userHash = hashVoterIdentifier(req.user.userId);
      const votes = queryAll<{ project_id: string }>(
        'SELECT project_id FROM community_votes WHERE voter_hash = ? OR voter_hash = ?',
        userHash,
        req.user.userId
      );
      for (const v of votes) userVotedProjectIds.push(v.project_id);

      const teamMember = queryOne<{ team_id: string }>(
        'SELECT team_id FROM team_members WHERE user_id = ? LIMIT 1',
        req.user.userId
      );
      if (teamMember) {
        const teamProj = queryOne<{ id: string }>(
          'SELECT id FROM projects WHERE team_id = ? LIMIT 1',
          teamMember.team_id
        );
        if (teamProj) userTeamProjectId = teamProj.id;
      }
    }

    const { getCommunityVotingBreakdown } = await import('../db/queries.js');
    const votingBreakdown = getCommunityVotingBreakdown();
    const voteMap = new Map(votingBreakdown.items.map(i => [i.project_id, i]));
    const projectsWithVotes = shuffled.map(p => ({
      ...p,
      vote_count: voteMap.get(p.id)?.vote_count ?? 0,
      vote_rank: voteMap.get(p.id)?.rank ?? 0
    }));

    return reply.view('voting.ejs', {
      title: 'Community Voting — PrismJudge',
      projects: projectsWithVotes,
      tracks,
      event,
      votingBreakdown,
      user: req.user,
      isVotingClosed: votingClosed,
      userVotedProjectId: userVotedProjectIds[0] || null,
      userVotedProjectIds,
      userTeamProjectId,
    });
  });

  // 2. Cast Community Vote (T3: Anti-Abuse, Rate Limited, Unique per Project)
  fastify.post<{ Body: CommunityVoteBody }>(
    '/api/vote',
    async (req: FastifyRequest<{ Body: CommunityVoteBody }>, reply: FastifyReply) => {
      const { project_id, voter_email } = req.body || {};

      if (!project_id) {
        return reply.code(400).send({ error: 'project_id is required' });
      }

      const ip = req.ip || '127.0.0.1';

      // Rate limit check: max 1 vote attempt per 3 seconds per IP
      const now = Date.now();
      const lastVote = voteRateLimitWindow.get(ip) || 0;
      if (now - lastVote < 3000) {
        return reply.code(429).send({ error: 'Too many requests. Please wait a few seconds before voting.' });
      }
      voteRateLimitWindow.set(ip, now);

      const event = getEvent();
      if (event?.voting_results_published === 1 || isVotingClosed(event)) {
        return reply.code(403).send({ error: 'Community voting has officially closed or results have been published' });
      }

      const voterIdentifier = req.user ? req.user.userId : voter_email ? voter_email.toLowerCase().trim() : ip;
      const voterHash = hashVoterIdentifier(voterIdentifier);
      const ipHash = hashVoterIdentifier(ip);

      const proj = queryOne<{ id: string; team_id: string }>(
        'SELECT id, team_id FROM projects WHERE id = ?',
        project_id
      );
      if (!proj) {
        return reply.code(404).send({ error: 'Project not found' });
      }

      // Self-voting prevention: users cannot vote for their own team
      if (req.user) {
        const isMember = queryOne<{ user_id: string }>(
          'SELECT user_id FROM team_members WHERE team_id = ? AND user_id = ?',
          proj.team_id,
          req.user.userId
        );
        if (isMember) {
          return reply.code(403).send({ error: 'Self-voting is not allowed. You cannot vote for your own team project.' });
        }
      }

      if (voter_email) {
        const isEmailMember = queryOne<{ user_id: string }>(
          'SELECT user_id FROM team_members WHERE team_id = ? AND LOWER(email) = ?',
          proj.team_id,
          voter_email.toLowerCase().trim()
        );
        if (isEmailMember) {
          return reply.code(403).send({ error: 'Self-voting is not allowed. You cannot vote for your own team project.' });
        }
      }

      // Check for duplicate vote on same project (check both hashed and raw ID)
      const existing = queryOne<{ id: string }>(
        'SELECT id FROM community_votes WHERE project_id = ? AND (voter_hash = ? OR voter_hash = ?)',
        project_id,
        voterHash,
        voterIdentifier
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
    }
  );

  // 3. Post Project Discussion Comment (T3: Discussion Stream)
  fastify.post<{ Params: { projectId: string }; Body: CommentBody }>(
    '/api/comments/:projectId',
    {
      preHandler: [rateLimit('write')],
    },
    async (req: FastifyRequest<{ Params: { projectId: string }; Body: CommentBody }>, reply: FastifyReply) => {
      const { projectId } = req.params;
      const { content, author_name } = req.body || {};
      const isHtml = req.headers.accept?.includes('text/html') || !req.headers['content-type']?.includes('application/json');

      if (!content || !content.trim()) {
        if (isHtml) {
          return reply.status(303).redirect(`/projects/${projectId}?error=empty_comment`);
        }
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

      if (isHtml) {
        return reply.status(303).redirect(`/projects/${projectId}`);
      }

      return reply.code(201).send({
        message: 'Comment posted',
        comment: { id: commentId, project_id: projectId, author_name: name, content: content.trim(), created_at: now },
      });
    }
  );
}
