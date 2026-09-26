import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';
import { execute } from '../src/db/index.js';

test('Submission Deadline Enforcement Tests', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('Submission rejected when event deadline is in past (403)', async () => {
    // In fixtures.json, event submissions_close is 2026-03-01T18:00:00Z (past)
    const res = await app.inject({
      method: 'POST',
      url: '/projects/new',
      headers: { cookie: 'session=prt_2e88' },
      payload: {
        title: 'Late Submission Probe',
        summary: 'Should be refused',
      },
    });

    assert.equal(res.statusCode, 403);
    const json = JSON.parse(res.body);
    assert.equal(json.error, 'Submissions closed');
  });

  await t.test('Submission accepted when deadline is in future (201)', async () => {
    // Temporarily extend deadline for this test
    const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    execute('UPDATE events SET submissions_close = ? WHERE id = ?', futureDate, 'evt_01');

    const res = await app.inject({
      method: 'POST',
      url: '/projects/new',
      headers: { cookie: 'session=prt_2e88' },
      payload: {
        title: 'Timely Submission',
        summary: 'Submitted before deadline',
        track_id: 'trk_01',
      },
    });

    assert.equal(res.statusCode, 201);
    const json = JSON.parse(res.body);
    assert.equal(json.message, 'Project submitted successfully');

    // Reset back to fixture date
    execute('UPDATE events SET submissions_close = ? WHERE id = ?', '2026-03-01T18:00:00Z', 'evt_01');
  });

  await app.close();
});
