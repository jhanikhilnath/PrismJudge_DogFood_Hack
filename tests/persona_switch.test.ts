import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';

test('Persona Switching & Role-Aware Navigation Tests', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('1. Switch to organizer without redirect navigates to /organizer/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/organizer' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/organizer/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=org_7f2a'));
    assert.ok(res.headers['set-cookie']?.toString().includes('prism_flash_switched'));
  });

  await t.test('2. Switch to judge_a without redirect navigates to /judge/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/judge_a' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/judge/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=jdg_a_91bc'));
  });

  await t.test('3. Switch to judge_b without redirect navigates to /judge/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/judge_b' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/judge/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=jdg_b_44de'));
  });

  await t.test('4. Switch to participant without redirect navigates to /projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/participant' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/projects');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=prt_2e88'));
  });

  await t.test('5. Contextual preservation: switching while on /results stays on /results', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/organizer?redirect=%2Fresults' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/results');
  });

  await t.test('6. Contextual preservation: switching while on /vote stays on /vote', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/judge_a?redirect=%2Fvote' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/vote');
  });

  await t.test('7. Cross-role protection: judge switching while on /organizer/dashboard routes to /judge/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/judge_a?redirect=%2Forganizer%2Fdashboard' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/judge/dashboard');
  });

  await t.test('8. Cross-role protection: participant switching while on /judge/dashboard routes to /projects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/participant?redirect=%2Fjudge%2Fdashboard' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/projects');
  });

  await t.test('9. Aliases: "judge" alias resolves to Judge A and navigates to /judge/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/judge' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/judge/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=jdg_a_91bc'));
  });

  await t.test('10. Aliases: "admin" alias resolves to Lead Organizer and navigates to /organizer/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/admin' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/organizer/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=org_7f2a'));
  });

  await t.test('11. User IDs: "jdg_02" resolves to Judge B and navigates to /judge/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/jdg_02' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/judge/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=jdg_b_44de'));
  });

  await t.test('12. User IDs: "usr_org" resolves to Lead Organizer and navigates to /organizer/dashboard', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/switch/usr_org' });
    assert.equal(res.statusCode, 302);
    assert.equal(res.headers.location, '/organizer/dashboard');
    assert.ok(res.headers['set-cookie']?.toString().includes('session=org_7f2a'));
  });

  await app.close();
});
