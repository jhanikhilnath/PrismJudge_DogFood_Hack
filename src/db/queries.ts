import { queryAll, queryOne } from './index.js';

export interface EventRecord {
  id: string;
  name: string;
  submissions_close: string;
  judging_close?: string | null;
  voting_close?: string | null;
  rubric_weights?: string;
  created_at?: string;
}

export interface TrackRecord {
  id: string;
  name: string;
  description?: string | null;
}

export interface ProjectDetails {
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

export interface TeamMemberRecord {
  user_id: string;
  email: string;
  role: string;
  name?: string;
}

export interface CommentRecord {
  id: string;
  author_name: string;
  content: string;
  created_at: string;
}

export interface ScoreRecord {
  id: string;
  judge_id: string;
  project_id: string;
  project_title: string;
  criteria: any;
  raw_total: number;
  comment: string | null;
  submitted_at: string;
}

export interface AuditLogRecord {
  id: string;
  actor_id: string | null;
  actor_role: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  payload?: string | null;
  ip_address?: string | null;
  created_at: string;
}

/**
 * Retrieve primary hackathon event information.
 */
export function getEvent(): EventRecord | undefined {
  return queryOne<EventRecord>(
    'SELECT id, name, submissions_close, judging_close, voting_close, rubric_weights FROM events LIMIT 1'
  );
}

/**
 * Check whether submissions have closed based on event deadline.
 */
export function isSubmissionsClosed(event?: EventRecord): boolean {
  const ev = event ?? getEvent();
  if (!ev) return false;
  return new Date().toISOString() > ev.submissions_close;
}

/**
 * Check whether community voting has closed based on event deadline.
 */
export function isVotingClosed(event?: EventRecord): boolean {
  const ev = event ?? getEvent();
  if (!ev || !ev.voting_close) return false;
  return new Date().toISOString() > ev.voting_close;
}

/**
 * Fetch all competition tracks sorted by identifier.
 */
export function getAllTracks(): TrackRecord[] {
  return queryAll<TrackRecord>('SELECT id, name, description FROM tracks ORDER BY id ASC');
}

/**
 * Fetch map of track ID to track name for fast lookups.
 */
export function getTrackMap(): Map<string, string> {
  const tracks = getAllTracks();
  return new Map(tracks.map((t) => [t.id, t.name]));
}

/**
 * Fetch map of team ID to team name for fast lookups.
 */
export function getTeamMap(): Map<string, string> {
  const teams = queryAll<{ id: string; name: string }>('SELECT id, name FROM teams');
  return new Map(teams.map((t) => [t.id, t.name]));
}

/**
 * Fetch project count grouped by track for active projects.
 */
export function getTrackCounts(): Record<string, number> {
  const counts = queryAll<{ track_id: string; cnt: number }>(
    'SELECT track_id, COUNT(*) as cnt FROM projects WHERE is_draft = 0 GROUP BY track_id'
  );
  const map: Record<string, number> = {};
  for (const c of counts) {
    map[c.track_id] = c.cnt;
  }
  return map;
}

/**
 * Query project gallery with optional search term and track filter.
 */
export function getProjects(options: { q?: string; track?: string; limit?: number } = {}): ProjectDetails[] {
  let sql = `
    SELECT 
      p.id,
      p.team_id,
      COALESCE(t.name, p.team_id) as team_name,
      p.track_id,
      COALESCE(tr.name, p.track_id) as track_name,
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

  if (options.q && options.q.trim()) {
    const term = `%${options.q.trim()}%`;
    sql += ' AND (p.title LIKE ? OR p.summary LIKE ?)';
    params.push(term, term);
  }

  if (options.track && options.track.trim()) {
    sql += ' AND p.track_id = ?';
    params.push(options.track.trim());
  }

  sql += ' ORDER BY p.submitted_at ASC, p.id ASC';

  if (options.limit && options.limit > 0) {
    sql += ` LIMIT ${Math.floor(options.limit)}`;
  }

  return queryAll<ProjectDetails>(sql, ...params);
}

/**
 * Query single project by identifier with team and track details.
 */
export function getProjectById(id: string): ProjectDetails | undefined {
  const sql = `
    SELECT 
      p.id,
      p.team_id,
      COALESCE(t.name, p.team_id) as team_name,
      p.track_id,
      COALESCE(tr.name, p.track_id) as track_name,
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
    WHERE p.id = ?
  `;
  return queryOne<ProjectDetails>(sql, id);
}

/**
 * Retrieve lightweight project list for voting or pairwise comparison.
 */
export function getProjectsForComparison(): Array<{ id: string; title: string; track_name: string; summary: string }> {
  return queryAll<{ id: string; title: string; track_name: string; summary: string }>(`
    SELECT p.id, p.title, COALESCE(tr.name, p.track_id) as track_name, p.summary
    FROM projects p
    LEFT JOIN tracks tr ON p.track_id = tr.id
    WHERE p.is_draft = 0
    ORDER BY p.id ASC
  `);
}

/**
 * Fetch team members associated with a team.
 */
export function getTeamMembers(teamId: string): TeamMemberRecord[] {
  return queryAll<TeamMemberRecord>(
    `SELECT tm.user_id, tm.email, tm.role, u.name
     FROM team_members tm
     LEFT JOIN users u ON tm.user_id = u.id
     WHERE tm.team_id = ?
     ORDER BY tm.role DESC, tm.email ASC`,
    teamId
  );
}

/**
 * Fetch project discussion comments in reverse chronological order.
 */
export function getProjectComments(projectId: string): CommentRecord[] {
  return queryAll<CommentRecord>(
    'SELECT id, author_name, content, created_at FROM comments WHERE project_id = ? ORDER BY created_at DESC',
    projectId
  );
}

/**
 * Retrieve scores awarded by a given judge, optionally filtered by project.
 */
export function getJudgeScores(judgeId: string, projectId?: string): ScoreRecord[] {
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
  const params: any[] = [judgeId];

  if (projectId) {
    sql += ' AND s.project_id = ?';
    params.push(projectId);
  }

  sql += ' ORDER BY s.submitted_at DESC';

  return queryAll<ScoreRecord>(sql, ...params);
}

/**
 * High-level counts for dashboards and landing page telemetry.
 */
export function getSystemStats() {
  const projectCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM projects WHERE is_draft = 0')?.count ?? 0;
  const judgeCount = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM users WHERE role = 'judge'")?.count ?? 0;
  const scoreCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM scores')?.count ?? 0;
  const voteCount = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM community_votes')?.count ?? 0;
  const tracks = getAllTracks();

  return {
    projectCount,
    judgeCount,
    trackCount: tracks.length,
    scoreCount,
    voteCount,
  };
}

/**
 * Retrieve judge evaluation progress for organizer console.
 */
export function getJudgeProgressList(): Array<{ id: string; name: string; email: string; reviews: number }> {
  return queryAll<{ id: string; name: string; email: string; reviews: number }>(`
    SELECT 
      u.id, 
      u.name, 
      u.email,
      (SELECT COUNT(*) FROM scores s WHERE s.judge_id = u.id) as reviews
    FROM users u
    WHERE u.role = 'judge'
    ORDER BY reviews ASC, u.name ASC
  `);
}

/**
 * Retrieve recent audit log entries.
 */
export function getRecentAuditLogs(limit = 15): AuditLogRecord[] {
  return queryAll<AuditLogRecord>(
    `SELECT id, actor_id, actor_role, action, resource_type, resource_id, payload, ip_address, created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT ?`,
    limit
  );
}
