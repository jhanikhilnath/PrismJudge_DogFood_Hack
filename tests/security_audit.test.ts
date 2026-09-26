import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';
import { timingSafeTokenEqual } from '../src/core/auth.js';

test('Security Audit & Automated Penetration Suite', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('SQL Injection Fuzzing on Gallery search parameter', async () => {
    const payloads = [
      "' OR '1'='1",
      "'; DROP TABLE projects; --",
      "' UNION SELECT null, null, null, null, null, null, null, null, null, null, null, null, null --",
      "1' AND SLEEP(5) --",
    ];

    for (const sqli of payloads) {
      const res = await app.inject({
        method: 'GET',
        url: `/projects?q=${encodeURIComponent(sqli)}`,
      });
      assert.equal(res.statusCode, 200, `SQLi probe "${sqli}" caused error ${res.statusCode}`);
      // Ensure database is intact and projects table was not dropped
      assert.ok(!res.body.includes('ERR_SQLITE_ERROR'), 'SQL error leaked in response');
    }
  });

  await t.test('Peer Snooping Matrix: No judge can inspect any other judge scores', async () => {
    const judgeTokens = [
      { token: 'jdg_a_91bc', id: 'jdg_01' },
      { token: 'jdg_b_44de', id: 'jdg_02' },
    ];

    for (const actor of judgeTokens) {
      for (const target of judgeTokens) {
        if (actor.id === target.id) continue;

        // Try query param with alias and raw id
        const probeAliases = [`judge_${target.id === 'jdg_01' ? 'a' : 'b'}`, target.id];
        for (const alias of probeAliases) {
          const res = await app.inject({
            method: 'GET',
            url: `/api/judge/scores?judge=${alias}`,
            headers: { cookie: `session=${actor.token}` },
          });
          assert.equal(
            res.statusCode,
            403,
            `Expected 403 when ${actor.id} probed ${alias}, got ${res.statusCode}`
          );
        }
      }
    }
  });

  await t.test('Privilege Escalation: Visitor & Participant denied admin routes', async () => {
    const restrictedUrls = [
      '/api/export.csv',
      '/organizer/dashboard',
      '/api/organizer/normalization',
      '/api/organizer/audit',
    ];

    for (const url of restrictedUrls) {
      // 1. Visitor (no auth)
      const resVisitor = await app.inject({ method: 'GET', url });
      assert.ok(
        resVisitor.statusCode === 401 || resVisitor.statusCode === 302,
        `Expected 401 or 302 for visitor on ${url}, got ${resVisitor.statusCode}`
      );

      // 2. Participant
      const resPart = await app.inject({
        method: 'GET',
        url,
        headers: { cookie: 'session=prt_2e88' },
      });
      assert.ok(
        resPart.statusCode === 403 || resPart.statusCode === 302,
        `Expected 403 or 302 for participant on ${url}, got ${resPart.statusCode}`
      );
    }
  });

  await t.test('Timing-Safe Comparison prevents timing side-channels', () => {
    assert.equal(timingSafeTokenEqual('token_abc123', 'token_abc123'), true);
    assert.equal(timingSafeTokenEqual('token_abc123', 'token_abc124'), false);
    assert.equal(timingSafeTokenEqual('token_abc123', 'short'), false);
    assert.equal(timingSafeTokenEqual(null as any, 'short'), false);
  });

  await t.test('Anti-Abuse: Sybil voting flood triggers rate limiting (HTTP 429)', async () => {
    // Attempt rapid consecutive votes
    let got429 = false;
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/vote',
        headers: { 'x-forwarded-for': '198.51.100.42' },
        payload: { project_id: 'prj_01' },
      });
      if (res.statusCode === 429) {
        got429 = true;
        break;
      }
    }
    assert.ok(got429, 'Rapid voting flood must trigger HTTP 429 Too Many Requests');
  });

  await app.close();
});
