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

  await t.test('Multi-stage exports return valid formatted CSV streams', () => {
    // 1. Raw scores
    const rawCsv = generateCSVExport('raw');
    const rawLines = rawCsv.trim().split('\r\n');
    assert.ok(rawLines[0]!.includes('score_id,judge_id,judge_name'), 'Raw CSV has expected header');
    assert.equal(rawLines.length, 127, 'Expected 1 header + 126 fixture scores');

    // 2. Normalized ratings
    const normCsv = generateCSVExport('normalized');
    const normLines = normCsv.trim().split('\r\n');
    assert.ok(normLines[0]!.includes('rank,raw_rank,rank_delta'), 'Normalized CSV has expected header');
    assert.equal(normLines.length, 42, 'Expected 1 header + 41 projects');

    // 3. Pairwise
    const pwCsv = generateCSVExport('pairwise');
    assert.ok(pwCsv.startsWith('comparison_id,judge_id'), 'Pairwise CSV header valid');

    // 4. Audit
    const auditCsv = generateCSVExport('audit');
    assert.ok(auditCsv.startsWith('id,timestamp,actor_id'), 'Audit CSV header valid');
  });
});
