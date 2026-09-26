import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';

test('DOGFOOD 2026 In-Memory Acceptance Suite Replicating run.py', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('T1: gallery is public (Status 200, no auth)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
    });
    assert.equal(res.statusCode, 200);
  });

  await t.test('T1: project from fixtures shown (Glass Signal in body)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/projects',
    });
    const body = res.body.toLowerCase();
    const containsFixtureTitle = body.includes('glass signal') || body.includes('quiet hours');
    assert.ok(containsFixtureTitle, 'Response body must contain seeded fixture project title');
  });

  await t.test('T1: closed event refuses submissions (POST /projects/new -> 4xx)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/projects/new',
      headers: {
        cookie: 'session=prt_2e88',
        'content-type': 'application/json',
      },
      payload: {
        title: 'dogfood-late-submission-probe',
        summary: 'probe',
      },
    });
    assert.ok(res.statusCode >= 400 && res.statusCode < 500, `Expected 4xx status, got ${res.statusCode}`);
  });

  await t.test('T2: judge sees own scores (GET /api/judge/scores as judge_a -> 200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores',
      headers: {
        cookie: 'session=jdg_a_91bc',
      },
    });
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.judge_id, 'jdg_01');
    assert.ok(Array.isArray(json.scores));
  });

  await t.test('T2: judge cannot see peer scores (GET /api/judge/scores?judge=judge_a as judge_b -> 401 or 403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores?judge=judge_a',
      headers: {
        cookie: 'session=jdg_b_44de',
      },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `Expected 401 or 403, got ${res.statusCode}`);
  });

  await t.test('T2: participant blocked from judging (GET /api/judge/scores as participant -> 401 or 403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores',
      headers: {
        cookie: 'session=prt_2e88',
      },
    });
    assert.ok(res.statusCode === 401 || res.statusCode === 403, `Expected 401 or 403, got ${res.statusCode}`);
  });

  await t.test('T2: csv export works (GET /api/export.csv as organizer -> 200, comma in line 1)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/export.csv',
      headers: {
        cookie: 'session=org_7f2a',
      },
    });
    assert.equal(res.statusCode, 200);
    const firstLine = res.body.split('\n')[0] || '';
    assert.ok(firstLine.includes(','), 'First line of CSV must contain comma separator');
    assert.ok(firstLine.includes('project_id'), 'CSV header must include project_id');
  });

  await app.close();
});
