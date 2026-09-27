import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabase } from '../src/db/seed.js';
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
});
