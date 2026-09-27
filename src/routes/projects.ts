import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import {
  execute,
  getAllTracks,
  getEvent,
  getProjectById,
  getProjectComments,
  getProjects,
  getTeamMembers,
  getTrackCounts,
  isSubmissionsClosed,
  queryOne,
} from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

interface GalleryQuery {
  q?: string;
  track?: string;
  format?: string;
}

interface NewProjectBody {
  title?: string;
  summary?: string;
  track_id?: string;
  repo_url?: string;
  demo_url?: string;
  is_draft?: boolean | number;
}

interface ProjectDetailQuery {
  error?: string;
}

export async function projectRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // 1. Public Project Gallery (T1: Public Gallery & Seeded Fixtures)
  fastify.get('/projects', async (req: FastifyRequest<{ Querystring: GalleryQuery }>, reply: FastifyReply) => {
    const query = req.query || {};
    const event = getEvent();
    const isClosed = isSubmissionsClosed(event);
    const projects = getProjects({ q: query.q, track: query.track });
    const tracks = getAllTracks();
    const trackCounts = getTrackCounts();

    const acceptsHtml = req.headers.accept?.includes('text/html');
    if (query.format === 'json' || (!acceptsHtml && req.headers.accept?.includes('application/json'))) {
      return reply.send({
        event,
        count: projects.length,
        projects,
        isClosed,
      });
    }

    return reply.view('gallery.ejs', {
      title: 'Project Gallery — DOGFOOD 2026',
      projects,
      tracks,
      trackCounts,
      event,
      user: req.user,
      isClosed,
      query: { q: query.q || '', track: query.track || '' },
    });
  });

  // 2. Project Submission Form (T1: Submissions View)
  fastify.get('/projects/new', async (req: FastifyRequest, reply: FastifyReply) => {
    const event = getEvent();
    const isClosed = isSubmissionsClosed(event);
    const tracks = getAllTracks();

    return reply.view('submit.ejs', {
      title: 'Submit Project — DOGFOOD 2026',
      tracks,
      event,
      user: req.user,
      isClosed,
      error: null,
    });
  });

  // 3. Project Submission Endpoint (T1 Check 3: Closed event refuses submissions with HTTP 403)
  fastify.post('/projects/new', async (req: FastifyRequest<{ Body: NewProjectBody }>, reply: FastifyReply) => {
    const event = getEvent();
    const now = new Date().toISOString();
    const deadlineClosed = isSubmissionsClosed(event);

    if (deadlineClosed) {
      logAuditEvent({
        actorId: req.user?.userId || 'unauthenticated',
        actorRole: req.user?.role || 'visitor',
        action: 'SUBMISSION_REJECTED_DEADLINE',
        resourceType: 'project',
        payload: { attemptTime: now, submissionsClose: event?.submissions_close },
        ipAddress: req.ip,
      });

      return reply.code(403).send({
        error: 'Submissions closed',
        detail: `The event closed for submissions at ${event?.submissions_close}. Late submissions are refused.`,
        closed_at: event?.submissions_close,
        attempted_at: now,
      });
    }

    if (!req.user) {
      return reply.code(401).send({ error: 'Authentication required to submit a project' });
    }

    const { title, summary, track_id, repo_url, demo_url, is_draft } = req.body || {};
    if (!title || !title.trim() || !summary || !summary.trim()) {
      return reply.code(400).send({ error: 'Title and summary are required' });
    }

    const teamMember = queryOne<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE user_id = ? LIMIT 1',
      req.user.userId
    );

    const teamId = teamMember?.team_id || 'tm_standalone';
    const chosenTrackId = track_id || 'trk_01';
    const projectId = `prj_${Date.now().toString(36)}`;

    execute(
      `INSERT INTO projects (id, team_id, track_id, title, summary, repo_url, demo_url, submitted_at, is_draft, is_duplicate, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      projectId,
      teamId,
      chosenTrackId,
      title.trim(),
      summary.trim(),
      repo_url || null,
      demo_url || null,
      now,
      is_draft ? 1 : 0,
      now,
      now
    );

    logAuditEvent({
      actorId: req.user.userId,
      actorRole: req.user.role,
      action: 'PROJECT_SUBMITTED',
      resourceType: 'project',
      resourceId: projectId,
      payload: { title: title.trim(), track_id: chosenTrackId, teamId },
      ipAddress: req.ip,
    });

    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect(`/projects/${projectId}`);
    }

    return reply.code(201).send({
      message: 'Project submitted successfully',
      projectId,
      title: title.trim(),
      submitted_at: now,
    });
  });

  // 4. Single Project Details & Discussion Stream
  fastify.get('/projects/:id', async (req: FastifyRequest<{ Params: { id: string }; Querystring: ProjectDetailQuery }>, reply: FastifyReply) => {
    const { id } = req.params;
    const project = getProjectById(id);

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const members = getTeamMembers(project.team_id);
    const comments = getProjectComments(id);

    let hasVotedForThis = false;
    if (req.user) {
      const userHash = crypto.createHash('sha256').update(req.user.userId).digest('hex').substring(0, 16);
      const vote = queryOne<{ id: string }>(
        'SELECT id FROM community_votes WHERE project_id = ? AND (voter_hash = ? OR voter_hash = ?)',
        id,
        userHash,
        req.user.userId
      );
      hasVotedForThis = Boolean(vote);
    }

    const formError = req.query?.error === 'empty_comment'
      ? 'Comment content cannot be empty. Please enter your feedback.'
      : null;

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({ project, members, comments });
    }

    return reply.view('project_detail.ejs', {
      title: `${project.title} — DOGFOOD 2026`,
      project,
      members,
      comments,
      user: req.user,
      hasVotedForThis,
      formError,
    });
  });
}
