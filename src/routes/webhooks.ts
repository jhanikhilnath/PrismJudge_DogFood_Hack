import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { getProjectById, getTeamMembers, queryOne } from '../db/index.js';
import { config } from '../config.js';

export async function webhookRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. Verifiable Certificate & Participation Diploma (T4 Stretch)
  // Strictly restricted to project team members and event organizers
  fastify.get('/certificates/:projectId', async (req: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
    const { projectId } = req.params;
    const project = getProjectById(projectId);

    if (!project) {
      if (req.headers.accept?.includes('text/html')) {
        return reply.code(404).view('404.ejs', {
          title: 'Certificate Not Found — PrismJudge',
          user: req.user,
          path: req.url,
        });
      }
      return reply.code(404).send({ error: 'Project certificate not found' });
    }

    // A. Authentication check
    if (!req.user) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      return reply.redirect(`/login?redirect=/certificates/${projectId}&error=Please+sign+in+to+view+your+certificate`);
    }

    // B. Authorization check: Event staff (organizer/admin) OR registered team member
    const isStaff = req.user.role === 'organizer' || req.user.role === 'admin';
    const isTeamMember = queryOne(
      'SELECT 1 FROM team_members WHERE team_id = ? AND user_id = ?',
      project.team_id,
      req.user.userId
    );

    if (!isStaff && !isTeamMember) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Certificates are private to project team members and event organizers.',
        });
      }
      return reply.code(403).view('certificate_restricted.ejs', {
        title: 'Access Restricted — PrismJudge',
        project,
        user: req.user,
      });
    }

    // C. Fetch team members to feature on certificate
    const members = getTeamMembers(project.team_id);

    // Cryptographic signature of participation
    const payload = `${project.id}:${project.team_id}:${project.submitted_at}`;
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({
        event: 'PrismJudge 2026',
        project,
        members,
        verification: {
          payload,
          algorithm: 'HMAC-SHA256',
          signature,
          verify_url: `${config.baseUrl}/certificates/${project.id}/verify`,
        },
      });
    }

    return reply.view('certificate.ejs', {
      title: `Official Certificate — ${project.title}`,
      project,
      members,
      signature,
      user: req.user,
    });
  });

  // 2. Public Credential Verification Endpoint
  fastify.get('/certificates/:projectId/verify', async (req: FastifyRequest<{ Params: { projectId: string } }>, reply: FastifyReply) => {
    const { projectId } = req.params;
    const project = getProjectById(projectId);

    if (!project) {
      return reply.code(404).send({ verified: false, error: 'Certificate record not found' });
    }

    return reply.send({
      verified: true,
      certificate_id: `DF26-${project.id.toUpperCase()}`,
      project_title: project.title,
      track: project.track_name,
      team: project.team_name,
      status: 'AUTHENTIC_CREDENTIAL_ISSUED',
    });
  });

  // 3. Verifiable Judge Participation Certificate (T4 Stretch)
  fastify.get('/certificates/judge/:judgeId', async (req: FastifyRequest<{ Params: { judgeId: string } }>, reply: FastifyReply) => {
    const { judgeId } = req.params;
    const { getJudgeParticipationRecord } = await import('../db/queries.js');
    const record = getJudgeParticipationRecord(judgeId);

    if (!record) {
      if (req.headers.accept?.includes('text/html')) {
        return reply.code(404).view('404.ejs', {
          title: 'Judge Record Not Found — PrismJudge',
          user: req.user,
          path: req.url,
        });
      }
      return reply.code(404).send({ error: 'Judge record not found' });
    }

    // A. Authentication check
    if (!req.user) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      return reply.redirect(`/login?redirect=/certificates/judge/${judgeId}&error=Please+sign+in+to+view+your+certificate`);
    }

    // B. Authorization check: Judge themselves or organizer/admin
    const isStaff = req.user.role === 'organizer' || req.user.role === 'admin';
    const isSelf = req.user.userId === judgeId;

    if (!isStaff && !isSelf) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(403).send({
          error: 'Forbidden',
          message: 'Juror commendations are private to the assigned evaluator and event organizers.',
        });
      }
      return reply.code(403).view('certificate_restricted.ejs', {
        title: 'Access Restricted — PrismJudge',
        project: { title: `Evaluator Commendation (${record.judge.name})` },
        user: req.user,
      });
    }

    // Cryptographic signature
    const payload = `judge:${record.judge.id}:${record.reviewsCount}:${record.tracks.join(',')}`;
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({
        event: 'PrismJudge 2026',
        credential_type: 'JUROR_COMMENDATION_RECORD',
        judge: record.judge,
        tracks: record.tracks,
        reviews_count: record.reviewsCount,
        verification: {
          payload,
          algorithm: 'HMAC-SHA256',
          signature,
          verify_url: `${config.baseUrl}/certificates/judge/${record.judge.id}/verify`,
        },
      });
    }

    return reply.view('judge_certificate.ejs', {
      title: `Juror Commendation — ${record.judge.name}`,
      judge: record.judge,
      tracks: record.tracks,
      reviewsCount: record.reviewsCount,
      signature,
      user: req.user,
    });
  });

  // 4. Public Judge Credential Verification Endpoint
  fastify.get('/certificates/judge/:judgeId/verify', async (req: FastifyRequest<{ Params: { judgeId: string } }>, reply: FastifyReply) => {
    const { judgeId } = req.params;
    const { getJudgeParticipationRecord } = await import('../db/queries.js');
    const record = getJudgeParticipationRecord(judgeId);

    if (!record) {
      return reply.code(404).send({ verified: false, error: 'Judge record not found' });
    }

    return reply.send({
      verified: true,
      credential_type: 'JUROR_COMMENDATION_RECORD',
      credential_id: `DF26-JDG-${record.judge.id.toUpperCase()}`,
      judge_id: record.judge.id,
      evaluator_name: record.judge.name,
      role: 'Technical Evaluator & Juror',
      reviews_contributed: record.reviewsCount,
      tracks_evaluated: record.tracks,
      status: 'AUTHENTIC_CREDENTIAL_ISSUED',
    });
  });

  // 5. Embeddable Project Gallery Widget (T4 Stretch)
  fastify.get('/embed/gallery', async (req: FastifyRequest, reply: FastifyReply) => {
    const { getProjects, getAllTracks } = await import('../db/queries.js');
    const query = req.query as { q?: string; track?: string } || {};
    const projects = getProjects({ q: query.q, track: query.track });
    const tracks = getAllTracks();

    return reply.view('embed_gallery.ejs', {
      title: 'PrismJudge — Project Showcase Widget',
      projects,
      tracks,
      currentTrack: query.track || '',
      searchQuery: query.q || '',
      user: req.user,
    });
  });

  // 6. Health Check
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', time: new Date().toISOString() });
  });
}
