import test from 'node:test';
import assert from 'node:assert/strict';
import { solveBradleyTerry, PairwiseComparisonRow } from '../src/engine/pairwise.js';

test('Bradley-Terry Pairwise Engine Tests', async (t) => {
  await t.test('Solves MM iterations on deterministic synthetic matches', () => {
    // Project A beats Project B, Project B beats Project C, Project A beats Project C
    const comparisons: PairwiseComparisonRow[] = [
      { id: '1', judge_id: 'j1', project_a: 'prj_A', project_b: 'prj_B', winner: 'project_a', created_at: '' },
      { id: '2', judge_id: 'j1', project_a: 'prj_A', project_b: 'prj_B', winner: 'project_a', created_at: '' },
      { id: '3', judge_id: 'j1', project_a: 'prj_B', project_b: 'prj_C', winner: 'project_a', created_at: '' },
      { id: '4', judge_id: 'j1', project_a: 'prj_A', project_b: 'prj_C', winner: 'project_a', created_at: '' },
    ];

    const result = solveBradleyTerry(comparisons);
    assert.ok(result.converged, 'Algorithm must converge within iteration limit');
    assert.ok(result.iterations > 0, 'Must perform at least 1 iteration');

    // Expected skill hierarchy: prj_A > prj_B > prj_C
    const skillA = result.ratings['prj_A']!.skill;
    const skillB = result.ratings['prj_B']!.skill;
    const skillC = result.ratings['prj_C']!.skill;

    assert.ok(skillA > skillB, `Expected skillA (${skillA}) > skillB (${skillB})`);
    assert.ok(skillB > skillC, `Expected skillB (${skillB}) > skillC (${skillC})`);
    assert.equal(result.rankedProjectIds[0], 'prj_A');
  });

  await t.test('Handles empty comparisons gracefully without error', () => {
    const result = solveBradleyTerry([]);
    assert.ok(result.converged);
    assert.ok(typeof result.ratings === 'object');
  });
});
