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
        title: 'Access Restricted — DOGFOOD 2026',
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

  // 3. Health Check
  fastify.get('/health', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', time: new Date().toISOString() });
  });
}
