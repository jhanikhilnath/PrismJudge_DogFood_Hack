import crypto from 'node:crypto';
import { execute } from '../db/index.js';

export function logAuditEvent(params: {
  actorId?: string | null;
  actorRole?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  payload?: any;
  ipAddress?: string | null;
}): void {
  try {
    const id = `aud_${crypto.randomBytes(8).toString('hex')}`;
    const payloadStr = params.payload ? JSON.stringify(params.payload) : null;
    const now = new Date().toISOString();

    execute(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, resource_type, resource_id, payload, ip_address, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      params.actorId || null,
      params.actorRole || null,
      params.action,
      params.resourceType,
      params.resourceId || null,
      payloadStr,
      params.ipAddress || null,
      now
    );
  } catch (err) {
    // Avoid crashing on logging failure
    console.error('Audit log failed:', err);
  }
}
