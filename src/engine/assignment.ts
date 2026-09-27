import crypto from 'node:crypto';
import { queryAll, queryOne, execute, transaction } from '../db/index.js';

export interface AssignmentItem {
  id: string;
  judgeId: string;
  judgeName?: string;
  projectId: string;
  projectTitle?: string;
  trackId?: string;
  batchId?: string;
  status: 'assigned' | 'completed';
  createdAt: string;
}

export interface AssignmentReport {
  totalProjects: number;
  totalJudges: number;
  reviewsPerProject: number;
  totalAssignments: number;
  minAssignmentsPerJudge: number;
  maxAssignmentsPerJudge: number;
  conflictsAvoided: number;
  batches: string[];
}

export interface AssignmentStats {
  totalAssignments: number;
  completedAssignments: number;
  pendingAssignments: number;
  completionRate: number;
}

/**
 * Checks if an evaluator has a Conflict of Interest (COI) with a project.
 * A conflict exists if the judge belongs to the project's team.
 */
export function hasConflictOfInterest(judgeId: string, projectId: string): boolean {
  const row = queryOne<{ count: number }>(
    `SELECT COUNT(*) as count
     FROM team_members tm
     JOIN projects p ON tm.team_id = p.team_id
     WHERE tm.user_id = ? AND p.id = ?`,
    judgeId,
    projectId
  );
  return (row?.count ?? 0) > 0;
}

/**
 * Deterministic pseudo-random number generator for seeded reproducible assignment.
 */
function seededRandom(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

/**
 * Generates balanced, conflict-free evaluator assignments across all active projects.
 *
 * Invariants:
 * 1. Coverage: Each submission receives exactly r = reviewsPerProject evaluators.
 * 2. Balance: Evaluator workloads differ by at most 1 (k = ceil(r * N_p / N_j)).
 * 3. COI Zero-Tolerance: No evaluator is assigned to their own team's submission.
 * 4. Disjoint Batches: Assignments are partitioned into batches for staged review.
 */
export function generateBalancedAssignments(opts?: {
  reviewsPerProject?: number;
  seed?: number;
}): AssignmentReport {
  const reviewsPerProject = opts?.reviewsPerProject ?? 3;
  const seed = opts?.seed ?? 42;
  const rand = seededRandom(seed);

  const projects = queryAll<{ id: string; team_id: string; track_id: string }>(
    'SELECT id, team_id, track_id FROM projects WHERE is_draft = 0 ORDER BY id ASC'
  );

  const judges = queryAll<{ id: string }>(
    "SELECT id FROM users WHERE role = 'judge' ORDER BY id ASC"
  );

  if (projects.length === 0 || judges.length === 0) {
    return {
      totalProjects: projects.length,
      totalJudges: judges.length,
      reviewsPerProject,
      totalAssignments: 0,
      minAssignmentsPerJudge: 0,
      maxAssignmentsPerJudge: 0,
      conflictsAvoided: 0,
      batches: [],
    };
  }

  // Pre-load all team memberships to build COI lookup table
  const teamMembers = queryAll<{ user_id: string; team_id: string }>(
    'SELECT user_id, team_id FROM team_members'
  );
  const judgeTeams = new Map<string, Set<string>>();
  for (const tm of teamMembers) {
    if (!judgeTeams.has(tm.user_id)) {
      judgeTeams.set(tm.user_id, new Set());
    }
    judgeTeams.get(tm.user_id)!.add(tm.team_id);
  }

  // Pre-load existing completed scores so historical reviews are marked completed
  const existingScores = queryAll<{ judge_id: string; project_id: string }>(
    'SELECT judge_id, project_id FROM scores'
  );
  const scoredSet = new Set<string>(
    existingScores.map((s) => `${s.judge_id}:${s.project_id}`)
  );

  // Judge load tracker
  const judgeLoad = new Map<string, number>();
  for (const j of judges) {
    judgeLoad.set(j.id, 0);
  }

  let conflictsAvoided = 0;
  const assignments: { id: string; judgeId: string; projectId: string; batchId: string; status: 'assigned' | 'completed' }[] = [];

  // Round-robin assignment per project with min-load greedy selection
  for (const project of projects) {
    const assignedJudges = new Set<string>();

    for (let r = 0; r < reviewsPerProject; r++) {
      // Find eligible judges not already assigned to this project and with no COI
      const eligible = judges.filter((j) => {
        if (assignedJudges.has(j.id)) return false;
        const teams = judgeTeams.get(j.id);
        if (teams && teams.has(project.team_id)) {
          conflictsAvoided++;
          return false;
        }
        return true;
      });

      if (eligible.length === 0) break; // Cannot assign more judges without conflict

      // Sort eligible by current load ascending, with random tie-break
      eligible.sort((a, b) => {
        const loadA = judgeLoad.get(a.id) || 0;
        const loadB = judgeLoad.get(b.id) || 0;
        if (loadA !== loadB) return loadA - loadB;
        return rand() - 0.5;
      });

      const selected = eligible[0]!;
      assignedJudges.add(selected.id);
      judgeLoad.set(selected.id, (judgeLoad.get(selected.id) || 0) + 1);

      const batchNum = Math.floor(assignments.length / 30) + 1;
      const batchId = `batch_${batchNum}`;
      const status: 'assigned' | 'completed' = scoredSet.has(`${selected.id}:${project.id}`)
        ? 'completed'
        : 'assigned';

      assignments.push({
        id: `asg_${crypto.randomBytes(6).toString('hex')}`,
        judgeId: selected.id,
        projectId: project.id,
        batchId,
        status,
      });
    }
  }

  // Atomically persist assignments in SQLite transaction
  transaction(() => {
    execute('DELETE FROM judge_assignments');
    for (const a of assignments) {
      execute(
        `INSERT INTO judge_assignments (id, judge_id, project_id, batch_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        a.id,
        a.judgeId,
        a.projectId,
        a.batchId,
        a.status
      );
    }
  });

  const loads = Array.from(judgeLoad.values());
  const minLoad = loads.length > 0 ? Math.min(...loads) : 0;
  const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;
  const batches = Array.from(new Set(assignments.map((a) => a.batchId)));

  return {
    totalProjects: projects.length,
    totalJudges: judges.length,
    reviewsPerProject,
    totalAssignments: assignments.length,
    minAssignmentsPerJudge: minLoad,
    maxAssignmentsPerJudge: maxLoad,
    conflictsAvoided,
    batches,
  };
}

/**
 * Retrieves assigned projects for a specific evaluator.
 */
export function getAssignmentsForJudge(judgeId: string): AssignmentItem[] {
  const rows = queryAll<{
    id: string;
    judge_id: string;
    project_id: string;
    batch_id: string | null;
    status: 'assigned' | 'completed';
    created_at: string;
    project_title?: string;
    track_id?: string;
  }>(
    `SELECT a.id, a.judge_id, a.project_id, a.batch_id, a.status, a.created_at,
            p.title as project_title, p.track_id
     FROM judge_assignments a
     JOIN projects p ON a.project_id = p.id
     WHERE a.judge_id = ?
     ORDER BY a.status ASC, p.title ASC`,
    judgeId
  );

  return rows.map((r) => ({
    id: r.id,
    judgeId: r.judge_id,
    projectId: r.project_id,
    projectTitle: r.project_title,
    trackId: r.track_id,
    batchId: r.batch_id || undefined,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/**
 * Retrieves all evaluator assignments for a specific project.
 */
export function getAssignmentsForProject(projectId: string): AssignmentItem[] {
  const rows = queryAll<{
    id: string;
    judge_id: string;
    judge_name?: string;
    project_id: string;
    batch_id: string | null;
    status: 'assigned' | 'completed';
    created_at: string;
  }>(
    `SELECT a.id, a.judge_id, u.name as judge_name, a.project_id, a.batch_id, a.status, a.created_at
     FROM judge_assignments a
     JOIN users u ON a.judge_id = u.id
     WHERE a.project_id = ?
     ORDER BY u.name ASC`,
    projectId
  );

  return rows.map((r) => ({
    id: r.id,
    judgeId: r.judge_id,
    judgeName: r.judge_name,
    projectId: r.project_id,
    batchId: r.batch_id || undefined,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/**
 * Marks an assignment completed when an evaluation score is submitted.
 */
export function markAssignmentCompleted(judgeId: string, projectId: string): void {
  execute(
    `UPDATE judge_assignments SET status = 'completed' WHERE judge_id = ? AND project_id = ?`,
    judgeId,
    projectId
  );
}

/**
 * Retrieves overall assignment progress telemetry.
 */
export function getAssignmentStats(): AssignmentStats {
  const total = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM judge_assignments')?.count ?? 0;
  const completed = queryOne<{ count: number }>("SELECT COUNT(*) as count FROM judge_assignments WHERE status = 'completed'")?.count ?? 0;
  const pending = total - completed;
  const completionRate = total > 0 ? (completed / total) * 100 : 0;

  return {
    totalAssignments: total,
    completedAssignments: completed,
    pendingAssignments: pending,
    completionRate: parseFloat(completionRate.toFixed(1)),
  };
}
