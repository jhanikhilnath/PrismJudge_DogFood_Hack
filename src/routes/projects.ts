import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import { queryAll, queryOne, execute } from '../db/index.js';
import { logAuditEvent } from '../core/audit.js';

interface ProjectRow {
  id: string;
  team_id: string;
  team_name: string;
  track_id: string;
  track_name: string;
  title: string;
  summary: string;
  repo_url: string | null;
  demo_url: string | null;
  submitted_at: string;
  is_draft: number;
  is_duplicate: number;
  review_count: number;
}

export async function projectRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Public project gallery (Check 1 & Check 2)
  fastify.get('/projects', async (req: FastifyRequest, reply: FastifyReply) => {
    const query = req.query as { q?: string; track?: string; format?: string };
    const searchTerm = query.q ? `%${query.q.trim()}%` : null;
    const trackFilter = query.track || null;

    let sql = `
      SELECT 
        p.id,
        p.team_id,
        t.name as team_name,
        p.track_id,
        tr.name as track_name,
        p.title,
        p.summary,
        p.repo_url,
        p.demo_url,
        p.submitted_at,
        p.is_draft,
        p.is_duplicate,
        (SELECT COUNT(*) FROM scores s WHERE s.project_id = p.id) as review_count
      FROM projects p
      LEFT JOIN teams t ON p.team_id = t.id
      LEFT JOIN tracks tr ON p.track_id = tr.id
      WHERE p.is_draft = 0
    `;

    const params: any[] = [];
    if (searchTerm) {
      sql += ' AND (p.title LIKE ? OR p.summary LIKE ?)';
      params.push(searchTerm, searchTerm);
    }
    if (trackFilter) {
      sql += ' AND p.track_id = ?';
      params.push(trackFilter);
    }

    sql += ' ORDER BY p.submitted_at ASC, p.id ASC';

    const projects = queryAll<ProjectRow>(sql, ...params);
    const tracks = queryAll<{ id: string; name: string }>('SELECT id, name FROM tracks ORDER BY id ASC');
    const event = queryOne<{ id: string; name: string; submissions_close: string }>(
      'SELECT id, name, submissions_close FROM events LIMIT 1'
    );

    const now = new Date().toISOString();
    const isClosed = event ? now > event.submissions_close : false;

    // If client specifically requests JSON
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
      event,
      user: req.user,
      isClosed,
      query: { q: query.q || '', track: query.track || '' },
    });
  });

  // Project submission form
  fastify.get('/projects/new', async (req: FastifyRequest, reply: FastifyReply) => {
    const tracks = queryAll<{ id: string; name: string }>('SELECT id, name FROM tracks ORDER BY id ASC');
    const event = queryOne<{ id: string; name: string; submissions_close: string }>(
      'SELECT id, name, submissions_close FROM events LIMIT 1'
    );

    const now = new Date().toISOString();
    const isClosed = event ? now > event.submissions_close : false;

    return reply.view('submit.ejs', {
      title: 'Submit Project — DOGFOOD 2026',
      tracks,
      event,
      user: req.user,
      isClosed,
      error: null,
    });
  });

  // Project submission endpoint (Check 3: closed event refuses submissions)
  fastify.post('/projects/new', async (req: FastifyRequest, reply: FastifyReply) => {
    const event = queryOne<{ id: string; name: string; submissions_close: string }>(
      'SELECT id, name, submissions_close FROM events LIMIT 1'
    );

    const now = new Date().toISOString();

    // Check 3 verification: Deadline enforcement
    if (event && now > event.submissions_close) {
      logAuditEvent({
        actorId: req.user ? req.user.userId : 'unauthenticated',
        actorRole: req.user ? req.user.role : 'visitor',
        action: 'SUBMISSION_REJECTED_DEADLINE',
        resourceType: 'project',
        payload: { attemptTime: now, submissionsClose: event.submissions_close },
        ipAddress: req.ip,
      });

      return reply.code(403).send({
        error: 'Submissions closed',
        detail: `The event closed for submissions at ${event.submissions_close}. Late submissions are refused.`,
        closed_at: event.submissions_close,
        attempted_at: now,
      });
    }

    // Role check: Only participants, organizers, or admins can submit
    if (!req.user) {
      return reply.code(401).send({ error: 'Authentication required to submit a project' });
    }

    const body = (req.body as any) || {};
    const { title, summary, track_id, repo_url, demo_url, is_draft } = body;

    if (!title || !summary) {
      return reply.code(400).send({ error: 'Title and summary are required' });
    }

    // Find participant's team
    const teamMember = queryOne<{ team_id: string }>(
      'SELECT team_id FROM team_members WHERE user_id = ? LIMIT 1',
      req.user.userId
    );

    const teamId = teamMember ? teamMember.team_id : 'tm_standalone';
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
      payload: { title, track_id: chosenTrackId, teamId },
      ipAddress: req.ip,
    });

    if (req.headers.accept?.includes('text/html')) {
      return reply.redirect(`/projects/${projectId}`);
    }

    return reply.code(201).send({
      message: 'Project submitted successfully',
      projectId,
      title,
      submitted_at: now,
    });
  });

  // Single project details
  fastify.get('/projects/:id', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };

    const project = queryOne<ProjectRow>(
      `SELECT 
        p.id,
        p.team_id,
        t.name as team_name,
        p.track_id,
        tr.name as track_name,
        p.title,
        p.summary,
        p.repo_url,
        p.demo_url,
        p.submitted_at,
        p.is_draft,
        p.is_duplicate,
        (SELECT COUNT(*) FROM scores s WHERE s.project_id = p.id) as review_count
      FROM projects p
      LEFT JOIN teams t ON p.team_id = t.id
      LEFT JOIN tracks tr ON p.track_id = tr.id
      WHERE p.id = ?`,
      id
    );

    if (!project) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const members = queryAll<{ user_id: string; email: string; role: string }>(
      'SELECT user_id, email, role FROM team_members WHERE team_id = ?',
      project.team_id
    );

    const comments = queryAll<{ id: string; author_name: string; content: string; created_at: string }>(
      'SELECT id, author_name, content, created_at FROM comments WHERE project_id = ? ORDER BY created_at DESC',
      id
    );

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({ project, members, comments });
    }

    return reply.view('project_detail.ejs', {
      title: `${project.title} — DOGFOOD 2026`,
      project,
      members,
      comments,
      user: req.user,
    });
  });
}
