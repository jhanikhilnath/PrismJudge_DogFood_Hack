import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';

test('Role Isolation & Access Control Security Tests', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('Unauthenticated user cannot view judge scores (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores',
    });
    assert.equal(res.statusCode, 401);
  });

  await t.test('Participant cannot view judge scores (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores',
      headers: { cookie: 'session=prt_2e88' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Participant cannot export CSV (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/export.csv',
      headers: { cookie: 'session=prt_2e88' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Judge cannot export CSV (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/export.csv',
      headers: { cookie: 'session=jdg_a_91bc' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Judge A cannot snoop on Judge B scores (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores?judge=judge_b',
      headers: { cookie: 'session=jdg_a_91bc' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Judge B cannot snoop on Judge A scores via IDOR (403)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores?judge=jdg_01',
      headers: { cookie: 'session=jdg_b_44de' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Organizer can inspect any judge scores (200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/judge/scores?judge=judge_a',
      headers: { cookie: 'session=org_7f2a' },
    });
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.judge_id, 'jdg_01');
  });

  await app.close();
});
