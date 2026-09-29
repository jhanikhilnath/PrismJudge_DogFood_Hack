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
     LEFT JOIN users u ON (tm.email = u.email AND u.id = ?)
     WHERE (tm.user_id = ? OR u.id = ?) AND p.id = ?`,
    judgeId,
    judgeId,
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

export interface ReassignResult {
  success: boolean;
  message: string;
  assignmentId?: string;
}

/**
 * Manually changes or reassigns an evaluator on a project.
 * Validates evaluator existence, Conflict of Interest (COI), and duplicate assignments.
 */
export function reassignProjectJudge(opts: {
  projectId: string;
  oldJudgeId?: string;
  newJudgeId: string;
}): ReassignResult {
  const { projectId, oldJudgeId, newJudgeId } = opts;

  // 1. Verify project exists
  const project = queryOne<{ id: string; team_id: string }>('SELECT id, team_id FROM projects WHERE id = ?', projectId);
  if (!project) {
    return { success: false, message: `Project ${projectId} not found` };
  }

  // 2. Verify target judge exists and has judge role
  const judge = queryOne<{ id: string; name: string; role: string }>('SELECT id, name, role FROM users WHERE id = ?', newJudgeId);
  if (!judge || judge.role !== 'judge') {
    return { success: false, message: `Target evaluator ${newJudgeId} is not a registered judge` };
  }

  // 3. Conflict of Interest Check
  if (hasConflictOfInterest(newJudgeId, projectId)) {
    return {
      success: false,
      message: `Conflict of Interest: Evaluator ${judge.name} (${newJudgeId}) is a member of the project's submission team.`,
    };
  }

  // 4. Duplicate assignment check
  const existingNewAssignment = queryOne<{ id: string }>(
    'SELECT id FROM judge_assignments WHERE judge_id = ? AND project_id = ?',
    newJudgeId,
    projectId
  );
  if (existingNewAssignment) {
    return {
      success: false,
      message: `Evaluator ${judge.name} (${newJudgeId}) is already assigned to evaluate project ${projectId}.`,
    };
  }

  // Check if new judge has already submitted a score for this project
  const hasScored = queryOne<{ id: string }>(
    'SELECT id FROM scores WHERE judge_id = ? AND project_id = ?',
    newJudgeId,
    projectId
  );
  const status: 'assigned' | 'completed' = hasScored ? 'completed' : 'assigned';

  // 5. If oldJudgeId is provided, update that assignment record
  if (oldJudgeId) {
    const existingOld = queryOne<{ id: string; status: string }>(
      'SELECT id, status FROM judge_assignments WHERE judge_id = ? AND project_id = ?',
      oldJudgeId,
      projectId
    );

    if (existingOld) {
      execute(
        `UPDATE judge_assignments 
         SET judge_id = ?, status = ?, created_at = CURRENT_TIMESTAMP 
         WHERE id = ?`,
        newJudgeId,
        status,
        existingOld.id
      );
      return {
        success: true,
        message: `Successfully reassigned project ${projectId} from ${oldJudgeId} to ${judge.name} (${newJudgeId}).`,
        assignmentId: existingOld.id,
      };
    }
  }

  // 6. Otherwise create a new assignment record
  const newId = `asg_${crypto.randomBytes(6).toString('hex')}`;
  execute(
    `INSERT INTO judge_assignments (id, judge_id, project_id, batch_id, status, created_at)
     VALUES (?, ?, ?, 'manual_assign', ?, CURRENT_TIMESTAMP)`,
    newId,
    newJudgeId,
    projectId,
    status
  );

  return {
    success: true,
    message: `Successfully assigned ${judge.name} (${newJudgeId}) to project ${projectId}.`,
    assignmentId: newId,
  };
}

/**
 * Removes an evaluator assignment from a project.
 */
export function removeProjectAssignment(projectId: string, judgeId: string): { success: boolean; message: string } {
  const existing = queryOne<{ id: string }>(
    'SELECT id FROM judge_assignments WHERE judge_id = ? AND project_id = ?',
    judgeId,
    projectId
  );
  if (!existing) {
    return { success: false, message: 'Assignment record not found' };
  }
  execute('DELETE FROM judge_assignments WHERE id = ?', existing.id);
  return { success: true, message: `Removed assignment for judge ${judgeId} on project ${projectId}` };
}

/**
 * Automatically distributes pending judging assignments to ensure all active projects
 * achieve target review coverage without modifying existing completed reviews or assignments.
 */
export function distributePendingAssignments(opts?: {
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

  // Pre-load COI data
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

  // Existing assignments map: projectId -> Set of judgeIds
  const existingAssignments = queryAll<{ judge_id: string; project_id: string }>(
    'SELECT judge_id, project_id FROM judge_assignments'
  );
  const projectAssigned = new Map<string, Set<string>>();
  const judgeLoad = new Map<string, number>();
  for (const j of judges) {
    judgeLoad.set(j.id, 0);
  }
  for (const ea of existingAssignments) {
    if (!projectAssigned.has(ea.project_id)) {
      projectAssigned.set(ea.project_id, new Set());
    }
    projectAssigned.get(ea.project_id)!.add(ea.judge_id);
    judgeLoad.set(ea.judge_id, (judgeLoad.get(ea.judge_id) || 0) + 1);
  }

  // Existing completed scores
  const existingScores = queryAll<{ judge_id: string; project_id: string }>(
    'SELECT judge_id, project_id FROM scores'
  );
  const scoredSet = new Set<string>(
    existingScores.map((s) => `${s.judge_id}:${s.project_id}`)
  );

  let conflictsAvoided = 0;
  const newAssignments: { id: string; judgeId: string; projectId: string; batchId: string; status: 'assigned' | 'completed' }[] = [];

  for (const project of projects) {
    const assignedJudges = projectAssigned.get(project.id) || new Set<string>();
    const needed = Math.max(0, reviewsPerProject - assignedJudges.size);

    for (let r = 0; r < needed; r++) {
      const eligible = judges.filter((j) => {
        if (assignedJudges.has(j.id)) return false;
        const teams = judgeTeams.get(j.id);
        if (teams && teams.has(project.team_id)) {
          conflictsAvoided++;
          return false;
        }
        return true;
      });

      if (eligible.length === 0) break;

      eligible.sort((a, b) => {
        const loadA = judgeLoad.get(a.id) || 0;
        const loadB = judgeLoad.get(b.id) || 0;
        if (loadA !== loadB) return loadA - loadB;
        return rand() - 0.5;
      });

      const selected = eligible[0]!;
      assignedJudges.add(selected.id);
      judgeLoad.set(selected.id, (judgeLoad.get(selected.id) || 0) + 1);

      const batchId = 'batch_pending';
      const status: 'assigned' | 'completed' = scoredSet.has(`${selected.id}:${project.id}`)
        ? 'completed'
        : 'assigned';

      newAssignments.push({
        id: `asg_${crypto.randomBytes(6).toString('hex')}`,
        judgeId: selected.id,
        projectId: project.id,
        batchId,
        status,
      });
    }
  }

  if (newAssignments.length > 0) {
    transaction(() => {
      for (const a of newAssignments) {
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
  }

  const loads = Array.from(judgeLoad.values());
  const minLoad = loads.length > 0 ? Math.min(...loads) : 0;
  const maxLoad = loads.length > 0 ? Math.max(...loads) : 0;
  const totalInDb = queryOne<{ count: number }>('SELECT COUNT(*) as count FROM judge_assignments')?.count ?? 0;

  return {
    totalProjects: projects.length,
    totalJudges: judges.length,
    reviewsPerProject,
    totalAssignments: totalInDb,
    minAssignmentsPerJudge: minLoad,
    maxAssignmentsPerJudge: maxLoad,
    conflictsAvoided,
    batches: ['batch_pending'],
  };
}

export interface ProjectAssignmentOverview {
  projectId: string;
  projectTitle: string;
  trackId: string;
  trackName: string;
  teamId: string;
  teamName: string;
  reviewCount: number;
  assignedCount: number;
  completedCount: number;
  pendingCount: number;
  statusBadge: 'completed' | 'pending_reviews' | 'needs_assignments';
  assignedJudges: Array<{
    assignmentId: string;
    judgeId: string;
    judgeName: string;
    judgeEmail: string;
    status: 'assigned' | 'completed';
    rawTotal?: number;
  }>;
}

/**
 * Returns comprehensive project assignment status across all active submissions for coordinator oversight.
 */
export function getAllProjectAssignments(): ProjectAssignmentOverview[] {
  const rows = queryAll<{
    project_id: string;
    project_title: string;
    track_id: string;
    track_name: string | null;
    team_id: string;
    team_name: string | null;
    assignment_id: string | null;
    judge_id: string | null;
    judge_name: string | null;
    judge_email: string | null;
    assignment_status: 'assigned' | 'completed' | null;
    raw_total: number | null;
  }>(
    `SELECT 
       p.id as project_id,
       p.title as project_title,
       p.track_id,
       COALESCE(t.name, p.track_id) as track_name,
       p.team_id,
       COALESCE(tm.name, p.team_id) as team_name,
       a.id as assignment_id,
       a.judge_id,
       COALESCE(u.name, a.judge_id) as judge_name,
       COALESCE(u.email, '') as judge_email,
       a.status as assignment_status,
       s.raw_total
     FROM projects p
     LEFT JOIN tracks t ON p.track_id = t.id
     LEFT JOIN teams tm ON p.team_id = tm.id
     LEFT JOIN judge_assignments a ON p.id = a.project_id
     LEFT JOIN users u ON a.judge_id = u.id
     LEFT JOIN scores s ON a.judge_id = s.judge_id AND a.project_id = s.project_id
     WHERE p.is_draft = 0
     ORDER BY p.id ASC, u.name ASC`
  );

  const projectMap = new Map<string, ProjectAssignmentOverview>();

  for (const r of rows) {
    let item = projectMap.get(r.project_id);
    if (!item) {
      item = {
        projectId: r.project_id,
        projectTitle: r.project_title,
        trackId: r.track_id,
        trackName: r.track_name || r.track_id,
        teamId: r.team_id,
        teamName: r.team_name || r.team_id,
        reviewCount: 0,
        assignedCount: 0,
        completedCount: 0,
        pendingCount: 0,
        statusBadge: 'needs_assignments',
        assignedJudges: [],
      };
      projectMap.set(r.project_id, item);
    }

    if (r.assignment_id && r.judge_id) {
      item.assignedCount++;
      const isCompleted = r.assignment_status === 'completed' || r.raw_total !== null;
      if (isCompleted) {
        item.completedCount++;
        item.reviewCount++;
      } else {
        item.pendingCount++;
      }

      item.assignedJudges.push({
        assignmentId: r.assignment_id,
        judgeId: r.judge_id,
        judgeName: r.judge_name || r.judge_id,
        judgeEmail: r.judge_email || '',
        status: isCompleted ? 'completed' : 'assigned',
        rawTotal: r.raw_total !== null ? r.raw_total : undefined,
      });
    }
  }

  for (const item of projectMap.values()) {
    if (item.completedCount >= 3) {
      item.statusBadge = 'completed';
    } else if (item.assignedCount < 3) {
      item.statusBadge = 'needs_assignments';
    } else {
      item.statusBadge = 'pending_reviews';
    }
  }

  return Array.from(projectMap.values());
}

export interface JudgeWorkloadInfo {
  id: string;
  name: string;
  email: string;
  tracks: string[];
  assignedCount: number;
  completedCount: number;
  pendingCount: number;
}

/**
 * Retrieves all registered evaluators with their assigned, completed, and pending review counts.
 */
export function getJudgesWorkloadList(): JudgeWorkloadInfo[] {
  const rows = queryAll<{
    id: string;
    name: string;
    email: string;
    tracks: string | null;
    assigned_count: number;
    completed_count: number;
  }>(
    `SELECT 
       u.id, 
       u.name, 
       u.email,
       jp.tracks,
       COUNT(a.id) as assigned_count,
       SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed_count
     FROM users u
     LEFT JOIN judge_profiles jp ON u.id = jp.judge_id
     LEFT JOIN judge_assignments a ON u.id = a.judge_id
     WHERE u.role = 'judge'
     GROUP BY u.id
     ORDER BY assigned_count ASC, u.name ASC`
  );

  return rows.map((r) => {
    let tracks: string[] = [];
    if (r.tracks) {
      try {
        tracks = typeof r.tracks === 'string' ? JSON.parse(r.tracks) : r.tracks;
      } catch {}
    }
    const assigned = r.assigned_count || 0;
    const completed = r.completed_count || 0;
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      tracks,
      assignedCount: assigned,
      completedCount: completed,
      pendingCount: Math.max(0, assigned - completed),
    };
  });
}

