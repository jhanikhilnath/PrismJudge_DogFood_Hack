import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
import { buildApp } from '../src/app.js';

test('OpenAPI 3.1 Specification & Route Conformance Tests', async (t) => {
  await t.test('openapi.yaml exists and parses to valid OpenAPI 3.1 object', () => {
    assert.ok(fs.existsSync('openapi.yaml'), 'openapi.yaml must exist at repo root');
    const content = fs.readFileSync('openapi.yaml', 'utf-8');
    const doc = YAML.parse(content);

    assert.equal(doc.openapi, '3.1.0', 'Must be OpenAPI 3.1.0');
    assert.ok(doc.info, 'Specification must contain info block');
    assert.ok(doc.info.title.includes('PrismJudge'), 'Title must contain PrismJudge');
    assert.ok(doc.paths, 'Specification must declare paths');
    assert.ok(Object.keys(doc.paths).length >= 20, 'Must document at least 20 paths');
  });

  await t.test('All critical competition endpoints are declared in openapi.yaml', () => {
    const content = fs.readFileSync('openapi.yaml', 'utf-8');
    const doc = YAML.parse(content);
    const paths = Object.keys(doc.paths);

    const requiredEndpoints = [
      '/api/judge/scores',
      '/api/export.csv',
      '/api/vote',
      '/healthz',
      '/readyz',
      '/api/organizer/audit',
      '/api/organizer/normalization',
      '/api/organizer/assignments/run',
      '/api/organizer/backup',
      '/normalization-proof.txt',
    ];

    for (const ep of requiredEndpoints) {
      assert.ok(paths.includes(ep), `Missing documented endpoint in openapi.yaml: ${ep}`);
    }
  });

  await t.test('Fastify server dynamically serves valid schema on /docs/json', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    assert.equal(res.statusCode, 200);

    const body = JSON.parse(res.body);
    assert.equal(body.openapi, '3.1.0');
    assert.ok(body.paths['/api/export.csv']);
    await app.close();
  });
});
