import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';
import { getEvent, getAllTracks } from '../src/db/queries.js';
import { getRecentAuditLogs } from '../src/db/index.js';

test('Event Settings, Configuration & Double Confirmation Tests', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('Unauthenticated visitor is redirected to login (302)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/organizer/settings',
    });
    assert.equal(res.statusCode, 302);
    assert.ok(res.headers.location?.includes('/login'));
  });

  await t.test('Participant receives HTTP 403 Forbidden for settings console', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/organizer/settings',
      headers: { cookie: 'session=prt_2e88' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('Organizer accesses settings console successfully (HTTP 200)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/organizer/settings',
      headers: { cookie: 'session=org_7f2a' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('Hackathon Configuration &amp; Rules'));
    assert.ok(res.body.includes('double-confirm-modal'));
    assert.ok(res.body.includes('submissions_close'));
  });

  await t.test('Updating event settings FAILS without double confirmation (HTTP 400)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/organizer/settings',
      headers: {
        cookie: 'session=org_7f2a',
        accept: 'application/json',
      },
      payload: {
        name: 'Unconfirmed Hackathon Name',
        // confirm_action missing
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Double confirmation required'));
  });

  await t.test('Updating event settings SUCCEEDS when double-confirmed with CONFIRM', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/organizer/settings',
      headers: {
        cookie: 'session=org_7f2a',
        accept: 'application/json',
      },
      payload: {
        name: 'PrismJudge Grand Hack 2026',
        tagline: 'The Definitive Precision Judging Platform',
        prize_pool: '$100,000 USD',
        max_team_size: 5,
        confirm_action: 'CONFIRM',
      },
    });
    assert.equal(res.statusCode, 200);

    const updated = getEvent();
    assert.equal(updated?.name, 'PrismJudge Grand Hack 2026');
    assert.equal(updated?.tagline, 'The Definitive Precision Judging Platform');
    assert.equal(updated?.prize_pool, '$100,000 USD');
    assert.equal(updated?.max_team_size, 5);

    // Verify audit log was recorded
    const logs = getRecentAuditLogs(5);
    const configLog = logs.find((l) => l.action === 'EVENT_SETTINGS_UPDATED');
    assert.ok(configLog, 'Must record EVENT_SETTINGS_UPDATED audit entry');
    assert.equal(configLog.actor_id, 'usr_org');
  });

  await t.test('Saving track requires double confirmation', async () => {
    // 1. Without confirmation: rejected 400
    const failRes = await app.inject({
      method: 'POST',
      url: '/api/organizer/tracks/save',
      headers: { cookie: 'session=org_7f2a' },
      payload: {
        id: 'trk_quantum',
        name: 'Quantum Systems',
      },
    });
    assert.equal(failRes.statusCode, 400);

    // 2. With confirmation: accepted 200
    const okRes = await app.inject({
      method: 'POST',
      url: '/api/organizer/tracks/save',
      headers: { cookie: 'session=org_7f2a' },
      payload: {
        id: 'trk_quantum',
        name: 'Quantum Systems',
        description: 'Algorithms and simulation for quantum computing',
        prize_amount: '$1,500',
        confirm_action: 'CONFIRM',
      },
    });
    assert.equal(okRes.statusCode, 200);

    const tracks = getAllTracks();
    const quantum = tracks.find((t) => t.id === 'trk_quantum');
    assert.ok(quantum, 'New track must exist in database');
    assert.equal(quantum.name, 'Quantum Systems');
    assert.equal(quantum.prize_amount, '$1,500');
  });

  await t.test('Deleting track with submitted projects is rejected', async () => {
    // trk_01 has projects in fixtures
    const res = await app.inject({
      method: 'POST',
      url: '/api/organizer/tracks/delete',
      headers: { cookie: 'session=org_7f2a' },
      payload: {
        id: 'trk_01',
        confirm_action: 'CONFIRM',
      },
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Cannot delete track'));
  });

  await t.test('Deleting empty track with double confirmation succeeds', async () => {
    // trk_quantum has 0 projects
    const res = await app.inject({
      method: 'POST',
      url: '/api/organizer/tracks/delete',
      headers: { cookie: 'session=org_7f2a' },
      payload: {
        id: 'trk_quantum',
        confirm_action: 'CONFIRM',
      },
    });
    assert.equal(res.statusCode, 200);

    const tracks = getAllTracks();
    assert.ok(!tracks.some((t) => t.id === 'trk_quantum'), 'Track must be deleted');
  });

  await app.close();
});
