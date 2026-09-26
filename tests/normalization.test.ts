import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabase } from '../src/db/seed.js';
import { computeBayesianNormalization } from '../src/engine/normalization.js';

test('Bayesian Normalization Engine & Math Proof Tests', async (t) => {
  seedDatabase();

  await t.test('Computes global prior mean and variance correctly', () => {
    const stats = computeBayesianNormalization();
    assert.ok(stats.globalMean > 0, 'Global mean must be positive');
    assert.ok(stats.globalStd > 0, 'Global std must be positive');
    assert.ok(Number.isFinite(stats.globalMean), 'Global mean must be finite');
    assert.ok(Number.isFinite(stats.globalStd), 'Global std must be finite');
  });

  await t.test('Judge jdg_07 zero-variance singularity is handled smoothly', () => {
    const stats = computeBayesianNormalization();
    const jdg07 = stats.judgeStats['jdg_07'];
    assert.ok(jdg07, 'Judge jdg_07 must exist in stats');
    assert.equal(jdg07.sampleStd, 0, 'Raw sample std must be 0 for identical scores');
    assert.ok(jdg07.shrunkStd > 0, 'Shrunk std must be strictly positive (> 0)');
    assert.ok(Number.isFinite(jdg07.shrunkStd), 'Shrunk std must be finite');
    assert.ok(Number.isFinite(jdg07.shrunkMean), 'Shrunk mean must be finite');
  });

  await t.test('All projects receive valid bounded normalized scores (0-100)', () => {
    const stats = computeBayesianNormalization();
    assert.equal(stats.projectRatings.length, 41, 'Must rate all 41 projects from fixtures');

    for (const p of stats.projectRatings) {
      assert.ok(p.normalizedScore >= 0 && p.normalizedScore <= 100, `Score ${p.normalizedScore} out of bounds`);
      assert.ok(!Number.isNaN(p.normalizedScore), `Project ${p.projectId} has NaN score`);
      assert.ok(p.rank >= 1 && p.rank <= 41, `Rank ${p.rank} out of bounds`);
    }
  });

  await t.test('Rankings are strictly descending by normalized score', () => {
    const stats = computeBayesianNormalization();
    for (let i = 0; i < stats.projectRatings.length - 1; i++) {
      const curr = stats.projectRatings[i]!;
      const next = stats.projectRatings[i + 1]!;
      assert.ok(
        curr.normalizedScore >= next.normalizedScore,
        `Ranking violation at rank ${curr.rank}: ${curr.normalizedScore} < ${next.normalizedScore}`
      );
    }
  });
});
