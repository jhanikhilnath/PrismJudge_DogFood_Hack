import fs from 'node:fs';
import path from 'node:path';
import { execute, transaction } from './index.js';
import { initializeSchema } from './schema.js';
import { config } from '../config.js';

export interface FixtureData {
  event: {
    id: string;
    name: string;
    submissions_close: string;
  };
  tracks: Array<{ id: string; name: string }>;
  judges: Array<{ id: string; name: string; email: string; tracks: string[] }>;
  teams: Array<{ id: string; name: string; members: string[] }>;
  projects: Array<{
    id: string;
    team: string;
    track: string;
    title: string;
    summary: string;
    repo_url?: string;
    demo_url?: string;
    submitted_at: string;
  }>;
  scores: Array<{
    judge: string;
    project: string;
    criteria: Record<string, number>;
    comment?: string;
  }>;
}

export function loadFixturesFile(): FixtureData {
  const candidatePaths = [
    config.fixturesPath,
    path.join(config.rootDir, 'fixtures.json'),
    path.join(config.rootDir, 'given', 'fixtures.json'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      const raw = fs.readFileSync(candidate, 'utf-8');
      return JSON.parse(raw) as FixtureData;
    }
  }

  throw new Error(`fixtures.json not found in candidate paths: ${candidatePaths.join(', ')}`);
}

export function seedDatabase(fixtures?: FixtureData): void {
  initializeSchema();
  const data = fixtures || loadFixturesFile();

  transaction(() => {
    // 1. Seed Event
    const defaultRubric = JSON.stringify({ functionality: 0.4, quality: 0.3, innovation: 0.3 });
    execute(
      `INSERT OR REPLACE INTO events (id, name, submissions_close, rubric_weights, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      data.event.id,
      data.event.name,
      data.event.submissions_close,
      defaultRubric,
      new Date().toISOString()
    );

    // 2. Seed Tracks
    for (const track of data.tracks) {
      execute(
        `INSERT OR REPLACE INTO tracks (id, event_id, name, description)
         VALUES (?, ?, ?, ?)`,
        track.id,
        data.event.id,
        track.name,
        `Track for ${track.name}`
      );
    }

    // 3. Seed Users & Judges from fixtures
    for (const judge of data.judges) {
      execute(
        `INSERT OR REPLACE INTO users (id, email, name, role, password_hash, created_at)
         VALUES (?, ?, ?, 'judge', 'hash_judge_default', ?)`,
        judge.id,
        judge.email,
        judge.name,
        new Date().toISOString()
      );

      execute(
        `INSERT OR REPLACE INTO judge_profiles (judge_id, tracks)
         VALUES (?, ?)`,
        judge.id,
        JSON.stringify(judge.tracks)
      );
    }

    // 4. Seed Teams & Members
    for (const team of data.teams) {
      const inviteCode = `inv_${team.id}`;
      execute(
        `INSERT OR REPLACE INTO teams (id, name, invite_code, created_at)
         VALUES (?, ?, ?, ?)`,
        team.id,
        team.name,
        inviteCode,
        new Date().toISOString()
      );

      for (let i = 0; i < team.members.length; i++) {
        const memberEmail = team.members[i];
        const memberUserId = `usr_${team.id}_${i + 1}`;
        execute(
          `INSERT OR IGNORE INTO users (id, email, name, role, password_hash, created_at)
           VALUES (?, ?, ?, 'participant', 'hash_participant', ?)`,
          memberUserId,
          memberEmail,
          memberEmail.split('@')[0],
          new Date().toISOString()
        );

        execute(
          `INSERT OR REPLACE INTO team_members (team_id, user_id, email, role)
           VALUES (?, ?, ?, 'member')`,
          team.id,
          memberUserId,
          memberEmail
        );
      }
    }

    // 5. Seed Projects (Detect and mark duplicates like prj_41 vs prj_07)
    const seenTeamProjects = new Map<string, string>();
    for (const proj of data.projects) {
      const isDuplicate = seenTeamProjects.has(proj.team) ? 1 : 0;
      seenTeamProjects.set(proj.team, proj.id);

      execute(
        `INSERT OR REPLACE INTO projects (id, team_id, track_id, title, summary, repo_url, demo_url, submitted_at, is_draft, is_duplicate, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        proj.id,
        proj.team,
        proj.track,
        proj.title,
        proj.summary,
        proj.repo_url || null,
        proj.demo_url || null,
        proj.submitted_at,
        isDuplicate,
        proj.submitted_at,
        proj.submitted_at
      );
    }

    // 6. Seed Scores
    const weights: Record<string, number> = { functionality: 0.4, quality: 0.3, innovation: 0.3 };
    for (const sc of data.scores) {
      let rawTotal = 0;
      for (const [k, v] of Object.entries(sc.criteria)) {
        rawTotal += (v || 0) * (weights[k] || 0.33);
      }
      const scoreId = `sc_${sc.judge}_${sc.project}`;

      execute(
        `INSERT OR REPLACE INTO scores (id, judge_id, project_id, criteria, raw_total, comment, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        scoreId,
        sc.judge,
        sc.project,
        JSON.stringify(sc.criteria),
        rawTotal,
        sc.comment || '',
        new Date().toISOString()
      );
    }

    // 7. Seed Explicit Test Accounts & Pre-Seeded Sessions
    const expiry = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

    // 7a. Organizer
    execute(
      `INSERT OR REPLACE INTO users (id, email, name, role, password_hash, created_at)
       VALUES ('usr_org', 'organizer@example.org', 'Lead Organizer', 'organizer', 'hash_org', ?)`,
      new Date().toISOString()
    );
    execute(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
       VALUES ('org_7f2a', 'usr_org', ?, ?)`,
      expiry,
      new Date().toISOString()
    );

    // 7b. Judge A (maps to jdg_01: Tomas Varga)
    execute(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
       VALUES ('jdg_a_91bc', 'jdg_01', ?, ?)`,
      expiry,
      new Date().toISOString()
    );

    // 7c. Judge B (maps to jdg_02: Elena Chen)
    execute(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
       VALUES ('jdg_b_44de', 'jdg_02', ?, ?)`,
      expiry,
      new Date().toISOString()
    );

    // 7d. Participant (assigned to tm_01)
    execute(
      `INSERT OR REPLACE INTO users (id, email, name, role, password_hash, created_at)
       VALUES ('usr_part', 'participant@example.org', 'Sample Participant', 'participant', 'hash_part', ?)`,
      new Date().toISOString()
    );
    execute(
      `INSERT OR REPLACE INTO team_members (team_id, user_id, email, role)
       VALUES ('tm_01', 'usr_part', 'participant@example.org', 'member')`
    );
    execute(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
       VALUES ('prt_2e88', 'usr_part', ?, ?)`,
      expiry,
      new Date().toISOString()
    );
    execute(
      `INSERT OR REPLACE INTO sessions (token, user_id, expires_at, created_at)
       VALUES ('usr_part_33aa', 'usr_part', ?, ?)`,
      expiry,
      new Date().toISOString()
    );
  });
}

export function printSeededLogins(): void {
  console.log('Seeded database successfully. Test logins:');
  console.log('  organizer    Cookie: session=org_7f2a');
  console.log('  judge_a      Cookie: session=jdg_a_91bc  (Tomas Varga)');
  console.log('  judge_b      Cookie: session=jdg_b_44de  (Elena Chen)');
  console.log('  participant  Cookie: session=prt_2e88    (Team tm_01)');
}

if (process.argv[1] && process.argv[1].endsWith('seed.ts')) {
  seedDatabase();
  printSeededLogins();
}
