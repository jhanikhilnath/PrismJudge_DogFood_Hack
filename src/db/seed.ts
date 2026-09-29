import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execute, transaction } from './index.js';
import { initializeSchema } from './schema.js';
import { config } from '../config.js';
import { generateBalancedAssignments } from '../engine/assignment.js';

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
    const defaultRubric = JSON.stringify({ functionality: 0.4, quality: 0.3, innovation: 0.2, impact: 0.1 });
    const defaultPrizes = JSON.stringify([
      { id: 'prz_01', name: '1st Place Grand Champion', amount: '$20,000', description: 'Top overall submission by composite normalized score across all tracks' },
      { id: 'prz_02', name: '2nd Place Runner-Up', amount: '$12,000', description: 'Second highest composite normalized evaluation score' },
      { id: 'prz_03', name: '3rd Place Podium Finalist', amount: '$6,000', description: 'Third highest composite normalized evaluation score' },
      { id: 'prz_04', name: 'Community Choice Award', amount: '$4,000', description: 'Most popular project chosen by public and peer community voting' },
      { id: 'prz_05', name: 'Best Technical Architecture', amount: '$3,000', description: 'Outstanding code quality, schema elegance, and systems design' },
      { id: 'prz_06', name: 'Innovation & Impact Award', amount: '$2,500', description: 'Most inventive concept with demonstrable real-world deployment potential' },
      { id: 'prz_07', name: 'Track Category Winners (8x)', amount: '$500 each', description: 'Highest ranked project within each of the 8 competitive tracks' }
    ]);

    execute(
      `INSERT OR REPLACE INTO events (
        id, name, tagline, description, submissions_open, submissions_close,
        judging_open, judging_close, voting_open, voting_close, results_announced_at,
        prize_pool, prizes, rubric_weights, min_reviews_per_project, max_team_size,
        require_repo_url, require_demo_url, voting_mode, prevent_self_voting, pairwise_enabled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.event.id,
      data.event.name,
      'Precision Hackathon Evaluation & Shrinkage Normalization Platform',
      'The premier technical hackathon evaluating engineering elegance, algorithmic innovation, and offline-first systems design with mathematical scoring rigor.',
      '2026-02-25T00:00:00Z',
      data.event.submissions_close,
      null,
      null,
      null,
      null,
      null,
      '$50,000 USD',
      defaultPrizes,
      defaultRubric,
      3,
      4,
      1,
      0,
      'open',
      1,
      1,
      new Date().toISOString()
    );

    // 2. Seed Tracks
    for (const track of data.tracks) {
      execute(
        `INSERT OR REPLACE INTO tracks (id, event_id, name, description, prize_amount)
         VALUES (?, ?, ?, ?, ?)`,
        track.id,
        data.event.id,
        track.name,
        `Track for ${track.name} — Building next-generation solutions in ${track.name}.`,
        '$500'
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

      const asgnId = `asgn_seed_${crypto.createHash('md5').update(`${sc.judge}_${sc.project}`).digest('hex').substring(0, 12)}`;
      execute(
        `INSERT OR REPLACE INTO judge_assignments (id, judge_id, project_id, batch_id, status, created_at)
         VALUES (?, ?, ?, 'batch_fixtures', 'completed', ?)`,
        asgnId,
        sc.judge,
        sc.project,
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

  // 9. Generate balanced conflict-free evaluator assignments
  generateBalancedAssignments({ reviewsPerProject: 3, seed: 42 });
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
