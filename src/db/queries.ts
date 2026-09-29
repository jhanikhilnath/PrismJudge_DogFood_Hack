import crypto from 'node:crypto';
import { queryAll, queryOne, execute, transaction } from './index.js';

export interface PrizeTier {
  id: string;
  name: string;
  amount: string;
  description: string;
}

export interface EventRecord {
  id: string;
  name: string;
  submissions_close: string;
  judging_close?: string | null;
  voting_close?: string | null;
  rubric_weights?: string;
  created_at?: string;
  tagline?: string | null;
  description?: string | null;
  submissions_open?: string | null;
  judging_open?: string | null;
  voting_open?: string | null;
  results_announced_at?: string | null;
  prize_pool?: string | null;
  prizes?: string | null;
  min_reviews_per_project?: number;
  max_team_size?: number;
  require_repo_url?: number;
  require_demo_url?: number;
  voting_mode?: string;
  prevent_self_voting?: number;
  pairwise_enabled?: number;
  results_published?: number;
  voting_results_published?: number;
}

export interface TrackRecord {
  id: string;
  name: string;
  description?: string | null;
  prize_amount?: string | null;
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
  return queryOne<EventRecord>('SELECT * FROM events LIMIT 1');
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
 * Update event configuration settings.
 */
export function updateEventSettings(updates: Partial<EventRecord>): void {
  const current = getEvent();
  if (!current) return;

  const ALLOWED_COLUMNS = new Set([
    'name', 'tagline', 'description', 'submissions_open', 'submissions_close',
    'judging_open', 'judging_close', 'voting_open', 'voting_close', 'results_announced_at',
    'prize_pool', 'prizes', 'rubric_weights', 'min_reviews_per_project', 'max_team_size',
    'require_repo_url', 'require_demo_url', 'voting_mode', 'prevent_self_voting',
    'pairwise_enabled', 'results_published', 'voting_results_published'
  ]);

  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (key === 'id' || !ALLOWED_COLUMNS.has(key)) continue;
    fields.push(`${key} = ?`);
    values.push(val);
  }

  if (fields.length === 0) return;
  values.push(current.id);

  execute(`UPDATE events SET ${fields.join(', ')} WHERE id = ?`, ...values);
}

/**
 * Fetch all competition tracks sorted by identifier.
 */
export function getAllTracks(): TrackRecord[] {
  return queryAll<TrackRecord>('SELECT id, name, description, prize_amount FROM tracks ORDER BY id ASC');
}

/**
 * Create or update a track.
 */
export function saveTrack(id: string, name: string, description: string, prizeAmount?: string): void {
  const currentEvent = getEvent();
  const eventId = currentEvent ? currentEvent.id : 'evt_01';

  const existing = queryOne<{ id: string }>('SELECT id FROM tracks WHERE id = ?', id);
  if (existing) {
    execute(
      'UPDATE tracks SET name = ?, description = ?, prize_amount = ? WHERE id = ?',
      name,
      description,
      prizeAmount || '$500',
      id
    );
  } else {
    execute(
      'INSERT INTO tracks (id, event_id, name, description, prize_amount) VALUES (?, ?, ?, ?, ?)',
      id,
      eventId,
      name,
      description,
      prizeAmount || '$500'
    );
  }
}

/**
 * Delete a track safely (preventing orphan project records).
 */
export function deleteTrack(id: string): { success: boolean; error?: string } {
  const projectCount = queryOne<{ cnt: number }>('SELECT count(*) as cnt FROM projects WHERE track_id = ?', id)?.cnt || 0;
  if (projectCount > 0) {
    return {
      success: false,
      error: `Cannot delete track: ${projectCount} project(s) are currently submitted to this track. Reassign or remove those projects first.`,
    };
  }
  execute('DELETE FROM tracks WHERE id = ?', id);
  return { success: true };
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
export function getProjectsForComparison(): Array<{
  id: string;
  title: string;
  track_id: string;
  track_name: string;
  summary: string;
  team_id: string;
  team_name: string;
  repo_url?: string;
  demo_url?: string;
}> {
  return queryAll<{
    id: string;
    title: string;
    track_id: string;
    track_name: string;
    summary: string;
    team_id: string;
    team_name: string;
    repo_url?: string;
    demo_url?: string;
  }>(`
    SELECT p.id, p.title, p.track_id, COALESCE(tr.name, p.track_id) as track_name, p.summary,
           p.repo_url, p.demo_url,
           p.team_id, COALESCE(tm.name, p.team_id) as team_name
    FROM projects p
    LEFT JOIN tracks tr ON p.track_id = tr.id
    LEFT JOIN teams tm ON p.team_id = tm.id
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
     ORDER BY rowid DESC
     LIMIT ?`,
    limit
  );
}

export interface QualifiedTeamRecord {
  team_id: string;
  team_name: string;
  invite_code: string;
  track_id: string | null;
  track_name: string | null;
  user_id: string | null;
  leader_name: string | null;
  leader_email: string | null;
  temporary_password: string | null;
  project_id: string | null;
  project_title: string | null;
  created_at: string;
}

/**
 * Retrieve all qualified teams with their generated login credentials and project status.
 */
export function getQualifiedTeamsWithCredentials(): QualifiedTeamRecord[] {
  return queryAll<QualifiedTeamRecord>(`
    SELECT 
      t.id as team_id,
      t.name as team_name,
      t.invite_code,
      p.track_id,
      COALESCE(tr.name, p.track_id, 'Unassigned') as track_name,
      COALESCE(u.id, tm.user_id, 'usr_part') as user_id,
      COALESCE(u.name, tm.email, 'Team Lead') as leader_name,
      COALESCE(tc.email, tm.email, u.email, lower(replace(t.name, ' ', '')) || '@dogfood.test') as leader_email,
      COALESCE(tc.temporary_password, 'DF26-ACTIVE') as temporary_password,
      p.id as project_id,
      p.title as project_title,
      t.created_at
    FROM teams t
    LEFT JOIN projects p ON p.team_id = t.id
    LEFT JOIN tracks tr ON p.track_id = tr.id
    LEFT JOIN (
      SELECT team_id, user_id, email,
             ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY CASE WHEN role = 'leader' THEN 0 ELSE 1 END, user_id ASC) as rn
      FROM team_members
    ) tm ON tm.team_id = t.id AND tm.rn = 1
    LEFT JOIN users u ON tm.user_id = u.id
    LEFT JOIN team_credentials tc ON tc.team_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at DESC, t.id ASC
  `);
}

/**
 * Helper to generate a human-memorable, secure temporary password.
 */
function generateTemporaryPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `DF26-${code}`;
}

/**
 * Create a new qualified team, generate a leader account with credentials, and link initial project.
 */
export function createQualifiedTeam(input: {
  teamName: string;
  trackId?: string;
  projectTitle?: string;
  leaderName: string;
  leaderEmail: string;
  customPassword?: string;
}): { teamId: string; userId: string; password: string; inviteCode: string } {
  return transaction(() => {
    const now = new Date().toISOString();
    const hexSuffix = Math.random().toString(16).substring(2, 8);
    const teamId = `tm_${hexSuffix}`;
    const userId = `usr_${hexSuffix}`;
    const inviteCode = `inv_${teamId}_${Math.random().toString(36).substring(2, 6)}`;
    const password = input.customPassword || generateTemporaryPassword();
    const salt = 'dogfood_salt_2026';
    const passwordHash = crypto.pbkdf2Sync(password, salt, 1000, 32, 'sha256').toString('hex');

    // Insert user account
    execute(
      `INSERT INTO users (id, email, name, role, password_hash, created_at)
       VALUES (?, ?, ?, 'participant', ?, ?)
       ON CONFLICT(email) DO UPDATE SET password_hash = excluded.password_hash`,
      userId,
      input.leaderEmail.trim().toLowerCase(),
      input.leaderName.trim(),
      passwordHash,
      now
    );

    // Retrieve actual user ID (in case user already existed by email)
    const actualUser = queryOne<{ id: string }>(
      'SELECT id FROM users WHERE email = ?',
      input.leaderEmail.trim().toLowerCase()
    );
    const finalUserId = actualUser?.id || userId;

    // Insert team
    execute(
      `INSERT INTO teams (id, name, invite_code, created_at)
       VALUES (?, ?, ?, ?)`,
      teamId,
      input.teamName.trim(),
      inviteCode,
      now
    );

    // Insert team member
    execute(
      `INSERT INTO team_members (team_id, user_id, email, role)
       VALUES (?, ?, ?, 'leader')`,
      teamId,
      finalUserId,
      input.leaderEmail.trim().toLowerCase()
    );

    // Record credentials for coordinator distribution
    execute(
      `INSERT INTO team_credentials (id, team_id, user_id, email, temporary_password, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      `cred_${hexSuffix}`,
      teamId,
      finalUserId,
      input.leaderEmail.trim().toLowerCase(),
      password,
      now
    );

    // If project title provided, create draft project with track validation
    if (input.projectTitle && input.projectTitle.trim()) {
      const projectId = `prj_${hexSuffix}`;
      let validTrack = input.trackId;
      if (validTrack) {
        const found = queryOne<{ id: string }>('SELECT id FROM tracks WHERE id = ?', validTrack);
        if (!found) validTrack = undefined;
      }
      const defaultTrack = validTrack || queryOne<{ id: string }>('SELECT id FROM tracks LIMIT 1')?.id || 'trk_01';
      execute(
        `INSERT INTO projects (id, team_id, track_id, title, summary, submitted_at, is_draft, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        projectId,
        teamId,
        defaultTrack,
        input.projectTitle.trim(),
        `Qualified entry from ${input.teamName.trim()}`,
        now,
        now,
        now
      );
    }

    // Audit log
    execute(
      `INSERT INTO audit_logs (id, actor_id, actor_role, action, resource_type, resource_id, payload, created_at)
       VALUES (?, 'usr_org', 'organizer', 'QUALIFIED_TEAM_CREATED', 'teams', ?, ?, ?)`,
      `aud_${Math.random().toString(36).substring(2, 10)}`,
      teamId,
      JSON.stringify({ teamName: input.teamName, email: input.leaderEmail, trackId: input.trackId }),
      now
    );

    return { teamId, userId: finalUserId, password, inviteCode };
  });
}

/**
 * Bulk import multiple qualified teams from parsed rows.
 */
export function bulkImportQualifiedTeams(rows: Array<{
  teamName: string;
  trackId?: string;
  projectTitle?: string;
  leaderName: string;
  leaderEmail: string;
}>): Array<{ teamId: string; teamName: string; leaderEmail: string; userId: string; password: string }> {
  const results: Array<{ teamId: string; teamName: string; leaderEmail: string; userId: string; password: string }> = [];

  for (const row of rows) {
    if (!row.teamName || !row.leaderEmail) continue;
    const res = createQualifiedTeam({
      teamName: row.teamName,
      trackId: row.trackId,
      projectTitle: row.projectTitle,
      leaderName: row.leaderName || row.teamName,
      leaderEmail: row.leaderEmail,
    });
    results.push({
      teamId: res.teamId,
      teamName: row.teamName,
      leaderEmail: row.leaderEmail,
      userId: res.userId,
      password: res.password,
    });
  }

  return results;
}

export interface WebhookRecord {
  id: string;
  url: string;
  event_types: string;
  secret: string | null;
  created_at: string;
}

export function getWebhooks(): WebhookRecord[] {
  return queryAll<WebhookRecord>('SELECT id, url, event_types, secret, created_at FROM webhooks ORDER BY created_at DESC');
}

export function createWebhook(url: string, eventTypes = 'all', secret?: string): string {
  const id = `whk_${Math.random().toString(36).substring(2, 10)}`;
  const now = new Date().toISOString();
  execute(
    'INSERT INTO webhooks (id, url, event_types, secret, created_at) VALUES (?, ?, ?, ?, ?)',
    id,
    url,
    eventTypes,
    secret || null,
    now
  );
  return id;
}

export function deleteWebhook(id: string): boolean {
  const res = execute('DELETE FROM webhooks WHERE id = ?', id);
  return Number(res.changes) > 0;
}

/**
 * Retrieve judge participation record for signed credential issuance.
 */
export function getJudgeParticipationRecord(judgeId: string) {
  const judge = queryOne<{ id: string; name: string; email: string; role: string; created_at: string }>(
    "SELECT id, name, email, role, created_at FROM users WHERE id = ? AND role = 'judge'",
    judgeId
  );
  if (!judge) return null;

  const profile = queryOne<{ tracks: string }>(
    'SELECT tracks FROM judge_profiles WHERE judge_id = ?',
    judgeId
  );
  let trackIds: string[] = [];
  try {
    if (profile?.tracks) trackIds = JSON.parse(profile.tracks);
  } catch {}

  const allTracks = getAllTracks();
  const trackMap = new Map(allTracks.map(t => [t.id, t.name]));
  const tracks = trackIds.map(tid => trackMap.get(tid) || tid);

  const reviewsCount = queryOne<{ count: number }>(
    'SELECT COUNT(*) as count FROM scores WHERE judge_id = ?',
    judgeId
  )?.count ?? 0;

  return {
    judge,
    tracks,
    reviewsCount,
  };
}

export interface CommunityVoteBreakdown {
  project_id: string;
  project_title: string;
  team_id: string;
  team_name: string;
  track_id: string;
  track_name: string;
  vote_count: number;
  vote_share_pct: number;
  rank: number;
}

/**
 * Retrieve comprehensive breakdown of community ballot votes across all projects.
 */
export function getCommunityVotingBreakdown(): {
  items: CommunityVoteBreakdown[];
  totalVotes: number;
  uniqueVoters: number;
  leadingProject: CommunityVoteBreakdown | null;
} {
  const totalVotesRow = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM community_votes');
  const totalVotes = totalVotesRow?.count ?? 0;

  const uniqueVotersRow = queryOne<{ count: number }>('SELECT COUNT(DISTINCT voter_hash) as count FROM community_votes');
  const uniqueVoters = uniqueVotersRow?.count ?? 0;

  const rows = queryAll<{
    project_id: string;
    project_title: string;
    team_id: string;
    team_name: string;
    track_id: string;
    track_name: string;
    vote_count: number;
  }>(`
    SELECT 
      p.id as project_id,
      p.title as project_title,
      t.id as team_id,
      t.name as team_name,
      tr.id as track_id,
      COALESCE(tr.name, 'General') as track_name,
      COUNT(cv.id) as vote_count
    FROM projects p
    JOIN teams t ON p.team_id = t.id
    JOIN tracks tr ON p.track_id = tr.id
    LEFT JOIN community_votes cv ON cv.project_id = p.id
    WHERE p.is_draft = 0
    GROUP BY p.id
    ORDER BY vote_count DESC, p.title ASC
  `);

  const items: CommunityVoteBreakdown[] = rows.map((r, idx) => {
    const voteShare = totalVotes > 0 ? (r.vote_count / totalVotes) * 100 : 0;
    return {
      project_id: r.project_id,
      project_title: r.project_title,
      team_id: r.team_id,
      team_name: r.team_name,
      track_id: r.track_id,
      track_name: r.track_name,
      vote_count: r.vote_count,
      vote_share_pct: Math.round(voteShare * 10) / 10,
      rank: idx + 1
    };
  });

  return {
    items,
    totalVotes,
    uniqueVoters,
    leadingProject: items.length > 0 && items[0].vote_count > 0 ? items[0] : null
  };
}

/**
 * Toggle whether the final results portal (/results) is published to the public.
 */
export function toggleResultsPublished(published: boolean): void {
  execute('UPDATE events SET results_published = ? WHERE id = (SELECT id FROM events LIMIT 1)', published ? 1 : 0);
}

/**
 * Toggle whether community ballot standings and vote counts are published to the public.
 */
export function toggleVotingResultsPublished(published: boolean): void {
  execute('UPDATE events SET voting_results_published = ? WHERE id = (SELECT id FROM events LIMIT 1)', published ? 1 : 0);
}
