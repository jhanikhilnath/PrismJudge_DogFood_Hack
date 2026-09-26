import test from 'node:test';
import assert from 'node:assert/strict';
import { seedDatabase } from '../src/db/seed.js';
import { generateCSVExport } from '../src/engine/ranking.js';

test('CSV Export & Leaderboard Integrity Tests', async (t) => {
  seedDatabase();

  await t.test('CSV contains valid comma-separated headers in row 1', () => {
    const csv = generateCSVExport();
    const lines = csv.split('\n');
    assert.ok(lines.length > 1, 'CSV must contain more than header row');

    const headers = lines[0]!.split(',');
    assert.ok(headers.includes('rank'), 'Header must include rank');
    assert.ok(headers.includes('project_id'), 'Header must include project_id');
    assert.ok(headers.includes('normalized_score'), 'Header must include normalized_score');
  });

  await t.test('Exports all 41 projects from fixtures with no empty rows', () => {
    const csv = generateCSVExport();
    const lines = csv.trim().split('\n');
    // 1 header + 41 data rows = 42 rows
    assert.equal(lines.length, 42, 'Expected 1 header + 41 projects = 42 lines');

    // Verify first data row format
    const row1 = lines[1]!.split(',');
    assert.equal(row1[0], '1', 'First project must have rank 1');
  });
});
