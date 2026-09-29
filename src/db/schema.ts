import { db } from './index.js';

export function initializeSchema(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      submissions_close TEXT NOT NULL,
      judging_close TEXT,
      voting_close TEXT,
      rubric_weights TEXT NOT NULL DEFAULT '{"functionality": 0.4, "quality": 0.3, "innovation": 0.3}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('visitor', 'participant', 'judge', 'organizer', 'admin')),
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS judge_profiles (
      judge_id TEXT PRIMARY KEY,
      tracks TEXT NOT NULL DEFAULT '[]',
      FOREIGN KEY (judge_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_members (
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      PRIMARY KEY (team_id, user_id),
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      track_id TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      repo_url TEXT,
      demo_url TEXT,
      submitted_at TEXT NOT NULL,
      is_draft INTEGER NOT NULL DEFAULT 0,
      is_duplicate INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS scores (
      id TEXT PRIMARY KEY,
      judge_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      criteria TEXT NOT NULL,
      raw_total REAL NOT NULL,
      comment TEXT,
      submitted_at TEXT NOT NULL,
      UNIQUE(judge_id, project_id),
      FOREIGN KEY (judge_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pairwise_comparisons (
      id TEXT PRIMARY KEY,
      judge_id TEXT NOT NULL,
      project_a TEXT NOT NULL,
      project_b TEXT NOT NULL,
      winner TEXT NOT NULL CHECK(winner IN ('project_a', 'project_b', 'tie')),
      created_at TEXT NOT NULL,
      FOREIGN KEY (judge_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_a) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (project_b) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS community_votes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      voter_hash TEXT NOT NULL,
      ip_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, voter_hash),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS comments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id TEXT,
      author_name TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      resource_type TEXT NOT NULL,
      resource_id TEXT,
      payload TEXT,
      ip_address TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS team_credentials (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      email TEXT NOT NULL,
      temporary_password TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      event_types TEXT NOT NULL DEFAULT 'all',
      secret TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      response_status INTEGER,
      response_body TEXT,
      error_message TEXT,
      delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS judge_assignments (
      id TEXT PRIMARY KEY,
      judge_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'assigned',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(judge_id, project_id),
      FOREIGN KEY (judge_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_projects_track ON projects(track_id);
    CREATE INDEX IF NOT EXISTS idx_projects_team ON projects(team_id);
    CREATE INDEX IF NOT EXISTS idx_scores_judge ON scores(judge_id);
    CREATE INDEX IF NOT EXISTS idx_scores_project ON scores(project_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_team_credentials_team ON team_credentials(team_id);
    CREATE INDEX IF NOT EXISTS idx_judge_assignments_judge ON judge_assignments(judge_id);
    CREATE INDEX IF NOT EXISTS idx_judge_assignments_project ON judge_assignments(project_id);
    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id);
  `);

  runEventSchemaMigrations();
}

function runEventSchemaMigrations(): void {
  try {
    const eventCols = db.prepare('PRAGMA table_info(events)').all() as { name: string }[];
    const colNames = new Set(eventCols.map((c) => c.name));

    if (!colNames.has('tagline')) db.exec('ALTER TABLE events ADD COLUMN tagline TEXT');
    if (!colNames.has('description')) db.exec('ALTER TABLE events ADD COLUMN description TEXT');
    if (!colNames.has('submissions_open')) db.exec('ALTER TABLE events ADD COLUMN submissions_open TEXT');
    if (!colNames.has('judging_open')) db.exec('ALTER TABLE events ADD COLUMN judging_open TEXT');
    if (!colNames.has('voting_open')) db.exec('ALTER TABLE events ADD COLUMN voting_open TEXT');
    if (!colNames.has('results_announced_at')) db.exec('ALTER TABLE events ADD COLUMN results_announced_at TEXT');
    if (!colNames.has('prize_pool')) db.exec('ALTER TABLE events ADD COLUMN prize_pool TEXT');
    if (!colNames.has('prizes')) db.exec('ALTER TABLE events ADD COLUMN prizes TEXT');
    if (!colNames.has('min_reviews_per_project')) db.exec('ALTER TABLE events ADD COLUMN min_reviews_per_project INTEGER DEFAULT 3');
    if (!colNames.has('max_team_size')) db.exec('ALTER TABLE events ADD COLUMN max_team_size INTEGER DEFAULT 4');
    if (!colNames.has('require_repo_url')) db.exec('ALTER TABLE events ADD COLUMN require_repo_url INTEGER DEFAULT 1');
    if (!colNames.has('require_demo_url')) db.exec('ALTER TABLE events ADD COLUMN require_demo_url INTEGER DEFAULT 0');
    if (!colNames.has('voting_mode')) db.exec("ALTER TABLE events ADD COLUMN voting_mode TEXT DEFAULT 'open'");
    if (!colNames.has('prevent_self_voting')) db.exec('ALTER TABLE events ADD COLUMN prevent_self_voting INTEGER DEFAULT 1');
    if (!colNames.has('pairwise_enabled')) db.exec('ALTER TABLE events ADD COLUMN pairwise_enabled INTEGER DEFAULT 1');
    if (!colNames.has('results_published')) db.exec('ALTER TABLE events ADD COLUMN results_published INTEGER DEFAULT 0');
    if (!colNames.has('voting_results_published')) db.exec('ALTER TABLE events ADD COLUMN voting_results_published INTEGER DEFAULT 0');

    const trackCols = db.prepare('PRAGMA table_info(tracks)').all() as { name: string }[];
    const trackColNames = new Set(trackCols.map((c) => c.name));
    if (!trackColNames.has('prize_amount')) db.exec("ALTER TABLE tracks ADD COLUMN prize_amount TEXT DEFAULT '$500'");
  } catch (err) {
    // Migration handled gracefully
  }
}
