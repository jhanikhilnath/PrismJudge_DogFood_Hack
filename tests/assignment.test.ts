import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabase } from '../src/db/seed.js';
import { buildApp } from '../src/app.js';
import {
  generateBalancedAssignments,
  getAssignmentsForJudge,
  getAssignmentsForProject,
  getAssignmentStats,
  hasConflictOfInterest,
} from '../src/engine/assignment.js';
import { queryOne, execute } from '../src/db/index.js';

test('Automated Balanced Judge Workload Assignment Tests', async (t) => {
  seedDatabase();

  await t.test('Generates balanced assignments meeting coverage and load bounds', () => {
    const report = generateBalancedAssignments({ reviewsPerProject: 3, seed: 42 });

    assert.equal(report.totalProjects, 41, 'Must assign for all 41 fixture projects');
    assert.equal(report.totalJudges, 30, 'Must utilize all 30 fixture evaluators');
    assert.equal(report.reviewsPerProject, 3, 'Coverage must be 3 reviews per project');
    assert.equal(report.totalAssignments, 41 * 3, 'Total assignments must be 123');

    // Balance invariant: workload delta <= 1 (e.g. 4 or 5 per judge)
    assert.ok(report.minAssignmentsPerJudge >= 4, 'Min load must be at least 4');
    assert.ok(report.maxAssignmentsPerJudge <= 5, 'Max load must be at most 5');
    assert.ok(
      report.maxAssignmentsPerJudge - report.minAssignmentsPerJudge <= 1,
      'Workload disparity between evaluators must be at most 1'
    );
  });

  await t.test('Every project has exactly 3 assigned evaluators', () => {
    const projects = [
      'prj_01', 'prj_05', 'prj_10', 'prj_15', 'prj_20', 'prj_25', 'prj_30', 'prj_35', 'prj_41'
    ];

    for (const pid of projects) {
      const assignments = getAssignmentsForProject(pid);
      assert.equal(assignments.length, 3, `Project ${pid} must have exactly 3 assignments`);
    }
  });

  await t.test('Conflict of Interest (COI) Defense Strictly Blocks Team Self-Scoring', () => {
    // usr_part is a member of tm_01 (owner of prj_01)
    const hasCoi = hasConflictOfInterest('usr_part', 'prj_01');
    assert.equal(hasCoi, true, 'usr_part must be flagged with COI on prj_01');

    const noCoi = hasConflictOfInterest('jdg_01', 'prj_01');
    assert.equal(noCoi, false, 'jdg_01 (independent evaluator) has no COI on prj_01');
  });

  await t.test('Assignment telemetry correctly reports counts and progress', () => {
    const stats = getAssignmentStats();
    assert.equal(stats.totalAssignments, 123);
    assert.ok(stats.completedAssignments >= 0);
    assert.ok(stats.pendingAssignments >= 0);
    assert.equal(stats.totalAssignments, stats.completedAssignments + stats.pendingAssignments);
  });

  await t.test('Manual judge reassignment works with strict COI and duplicate defense', async () => {
    const { reassignProjectJudge, getAllProjectAssignments } = await import('../src/engine/assignment.js');

    // 1. Get current assigned judges for prj_02
    const currentAssignments = getAssignmentsForProject('prj_02');
    assert.ok(currentAssignments.length >= 3, 'prj_02 must have at least 3 assignments');
    const oldJudgeId = currentAssignments[0].judgeId;

    // Find an unassigned judge for prj_02
    const assignedIds = new Set(currentAssignments.map(a => a.judgeId));
    let targetJudgeId = '';
    for (let i = 1; i <= 30; i++) {
      const candidateId = `jdg_${String(i).padStart(2, '0')}`;
      if (!assignedIds.has(candidateId) && !hasConflictOfInterest(candidateId, 'prj_02')) {
        targetJudgeId = candidateId;
        break;
      }
    }
    assert.ok(targetJudgeId, 'Must find an eligible target judge');

    // Perform successful reassignment
    const res = reassignProjectJudge({
      projectId: 'prj_02',
      oldJudgeId,
      newJudgeId: targetJudgeId,
    });
    assert.equal(res.success, true);
    assert.ok(res.message.includes('Successfully reassigned'));

    // Verify in database
    const updatedAssignments = getAssignmentsForProject('prj_02');
    const newAssignedIds = new Set(updatedAssignments.map(a => a.judgeId));
    assert.ok(newAssignedIds.has(targetJudgeId), 'Target judge must now be assigned to prj_02');
    assert.ok(!newAssignedIds.has(oldJudgeId), 'Old judge must no longer be assigned to prj_02');

    // 2. Reject duplicate assignment
    const dupRes = reassignProjectJudge({
      projectId: 'prj_02',
      newJudgeId: targetJudgeId,
    });
    assert.equal(dupRes.success, false);
    assert.ok(dupRes.message.includes('already assigned'));

    // 3. Reject assignment for non-judge
    const nonJudgeRes = reassignProjectJudge({
      projectId: 'prj_02',
      newJudgeId: 'usr_part',
    });
    assert.equal(nonJudgeRes.success, false);
    assert.ok(nonJudgeRes.message.includes('not a registered judge'));
  });

  await t.test('distributePendingAssignments fills missing reviews while preserving existing', async () => {
    const { distributePendingAssignments, removeProjectAssignment } = await import('../src/engine/assignment.js');

    // Remove one assignment from prj_03
    const asgBefore = getAssignmentsForProject('prj_03');
    const removedJudgeId = asgBefore[0].judgeId;
    removeProjectAssignment('prj_03', removedJudgeId);

    const asgAfterRemove = getAssignmentsForProject('prj_03');
    assert.equal(asgAfterRemove.length, 2, 'prj_03 should now have only 2 assignments');

    // Run incremental pending distribution
    const report = distributePendingAssignments({ reviewsPerProject: 3 });
    assert.ok(report.totalAssignments >= 123, 'Total assignments must be restored to 123+');

    const asgRestored = getAssignmentsForProject('prj_03');
    assert.equal(asgRestored.length, 3, 'prj_03 must have 3 assignments restored');
  });

  await t.test('getAllProjectAssignments and getJudgesWorkloadList report valid overviews', async () => {
    const { getAllProjectAssignments, getJudgesWorkloadList } = await import('../src/engine/assignment.js');

    const projects = getAllProjectAssignments();
    assert.equal(projects.length, 41, 'Must return all 41 projects');
    const prj1 = projects.find(p => p.projectId === 'prj_01');
    assert.ok(prj1);
    assert.equal(prj1.projectTitle, 'Glass Signal');
    assert.ok(prj1.assignedJudges.length >= 3);

    const judges = getJudgesWorkloadList();
    assert.equal(judges.length, 30, 'Must return all 30 evaluators');
    assert.ok(judges.every(j => typeof j.assignedCount === 'number'));
  });

  await t.test('HTTP API: Reassign and distribution endpoints enforce RBAC and execute correctly', async () => {
    const app = await buildApp();

    // 1. Participant is blocked from reassigning (403)
    const resPart = await app.inject({
      method: 'POST',
      url: '/api/organizer/assignments/reassign',
      headers: { cookie: 'session=prt_2e88' },
      payload: { projectId: 'prj_05', newJudgeId: 'jdg_01' },
    });
    assert.equal(resPart.statusCode, 403);

    // 2. Organizer can reassign a judge (200)
    const asgBefore = getAssignmentsForProject('prj_05');
    const oldJudge = asgBefore[0].judgeId;
    const currentJudges = new Set(asgBefore.map(a => a.judgeId));
    let targetJudge = '';
    for (let i = 1; i <= 30; i++) {
      const id = `jdg_${String(i).padStart(2, '0')}`;
      if (!currentJudges.has(id)) {
        targetJudge = id;
        break;
      }
    }

    const resOrg = await app.inject({
      method: 'POST',
      url: '/api/organizer/assignments/reassign',
      headers: { cookie: 'session=org_7f2a' },
      payload: { projectId: 'prj_05', oldJudgeId: oldJudge, newJudgeId: targetJudge },
    });
    assert.equal(resOrg.statusCode, 200);
    const bodyOrg = JSON.parse(resOrg.body);
    assert.equal(bodyOrg.ok, true);

    // 3. Organizer can trigger pending workload distribution (200)
    const resRun = await app.inject({
      method: 'POST',
      url: '/api/organizer/assignments/run',
      headers: { cookie: 'session=org_7f2a' },
      payload: { mode: 'pending_only', reviewsPerProject: 3 },
    });
    assert.equal(resRun.statusCode, 200);
    const bodyRun = JSON.parse(resRun.body);
    assert.equal(bodyRun.ok, true);

    // 4. Organizer can fetch assignment matrix (200)
    const resMatrix = await app.inject({
      method: 'GET',
      url: '/api/organizer/assignments/matrix',
      headers: { cookie: 'session=org_7f2a' },
    });
    assert.equal(resMatrix.statusCode, 200);
    const bodyMatrix = JSON.parse(resMatrix.body);
    assert.equal(bodyMatrix.projects.length, 41);
    assert.equal(bodyMatrix.judges.length, 30);
  });
});
