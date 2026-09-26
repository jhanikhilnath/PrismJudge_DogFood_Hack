import { FastifyInstance, FastifyPluginOptions, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import { queryOne, queryAll } from '../db/index.js';
import { config } from '../config.js';

export async function webhookRoutes(fastify: FastifyInstance, _opts: FastifyPluginOptions): Promise<void> {
  // Verifiable Certificate & Participation Record (T4 Stretch)
  // Access is strictly restricted to project team members and event organizers
  fastify.get('/certificates/:projectId', async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };

    const project = queryOne<{
      id: string;
      title: string;
      team_id: string;
      team_name: string;
      track_name: string;
      submitted_at: string;
    }>(
      `SELECT p.id, p.title, p.team_id, t.name as team_name, tr.name as track_name, p.submitted_at
       FROM projects p
       LEFT JOIN teams t ON p.team_id = t.id
       LEFT JOIN tracks tr ON p.track_id = tr.id
       WHERE p.id = ?`,
      projectId
    );

    if (!project) {
      return reply.code(404).send({ error: 'Project certificate not found' });
    }

    // 1. Authentication check
    if (!req.user) {
      if (req.headers.accept?.includes('application/json')) {
        return reply.code(401).send({ error: 'Unauthorized', message: 'Authentication required' });
      }
      return reply.redirect(`/login?redirect=/certificates/${projectId}&error=Please+sign+in+to+view+your+certificate`);
    }

    // 2. Authorization check: Must be event staff (organizer/admin) OR a registered member of this team
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
        title: 'Access Restricted — DOGFOOD 2026',
        project,
        user: req.user,
      });
    }

    // 3. Authorized: Fetch team members to feature on certificate
    const members = queryAll<{ user_id: string; email: string; role: string }>(
      'SELECT user_id, email, role FROM team_members WHERE team_id = ?',
      project.team_id
    );

    // Cryptographic signature of participation
    const payload = `${project.id}:${project.team_id}:${project.submitted_at}`;
    const signature = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('hex');

    if (req.headers.accept?.includes('application/json')) {
      return reply.send({
        event: 'DOGFOOD 2026',
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

  // Public Credential Verification Endpoint
  fastify.get('/certificates/:projectId/verify', async (req: FastifyRequest, reply: FastifyReply) => {
    const { projectId } = req.params as { projectId: string };
    const project = queryOne<{
      id: string;
      title: string;
      team_name: string;
      track_name: string;
      submitted_at: string;
    }>(
      `SELECT p.id, p.title, t.name as team_name, tr.name as track_name, p.submitted_at
       FROM projects p
       LEFT JOIN teams t ON p.team_id = t.id
       LEFT JOIN tracks tr ON p.track_id = tr.id
       WHERE p.id = ?`,
      projectId
    );

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

  // Health check endpoint
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', time: new Date().toISOString() });
  });
}
