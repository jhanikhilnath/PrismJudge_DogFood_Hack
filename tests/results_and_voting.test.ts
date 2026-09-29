import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/app.js';
import { seedDatabase } from '../src/db/seed.js';

test('Results Portal & Community Voting Standings Verification Suite', async (t) => {
  seedDatabase();
  const app = await buildApp();

  await t.test('1. Embargoed results portal renders polite notice to visitors', async () => {
    // Ensure results are embargoed
    const { toggleResultsPublished } = await import('../src/db/queries.js');
    toggleResultsPublished(false);

    const res = await app.inject({
      method: 'GET',
      url: '/results',
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Competition Results Are Embargoed/i);
    assert.match(res.payload, /Official Results Unveiling Ceremony/i);
  });

  await t.test('2. Organizer can preview embargoed results portal with preview banner', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/results',
      headers: {
        cookie: 'session=org_7f2a',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.match(res.payload, /Organizer Confidential Preview/i);
    assert.match(res.payload, /Overall Podium Champions/i);
    assert.match(res.payload, /Comprehensive Final Standings/i);
  });

  await t.test('3. Non-organizer cannot toggle results or voting publication (HTTP 403)', async () => {
    const resResults = await app.inject({
      method: 'POST',
      url: '/api/organizer/results/toggle',
      headers: {
        cookie: 'session=usr_part_33aa',
      },
      payload: { published: true },
    });
    assert.equal(resResults.statusCode, 403);

    const resVoting = await app.inject({
      method: 'POST',
      url: '/api/organizer/voting-results/toggle',
      headers: {
        cookie: 'session=usr_part_33aa',
      },
      payload: { published: true },
    });
    assert.equal(resVoting.statusCode, 403);
  });

  await t.test('4. Organizer successfully toggles results publication', async () => {
    const resToggle = await app.inject({
      method: 'POST',
      url: '/api/organizer/results/toggle',
      headers: {
        cookie: 'session=org_7f2a',
      },
      payload: { published: true },
    });
    assert.equal(resToggle.statusCode, 200);
    const data = JSON.parse(resToggle.payload);
    assert.equal(data.ok, true);
    assert.equal(data.results_published, 1);

    // Visitor now accesses /results and sees the published champions
    const resVisitor = await app.inject({
      method: 'GET',
      url: '/results',
    });
    assert.equal(resVisitor.statusCode, 200);
    assert.match(resVisitor.payload, /Overall Podium Champions/i);
    assert.match(resVisitor.payload, /GRAND CHAMPION/i);
    assert.doesNotMatch(resVisitor.payload, /Organizer Confidential Preview/i);
  });

  await t.test('5. Organizer toggles voting results publication and verified tallies appear on /vote', async () => {
    const resToggle = await app.inject({
      method: 'POST',
      url: '/api/organizer/voting-results/toggle',
      headers: {
        cookie: 'session=org_7f2a',
      },
      payload: { published: true },
    });
    assert.equal(resToggle.statusCode, 200);
    const data = JSON.parse(resToggle.payload);
    assert.equal(data.ok, true);
    assert.equal(data.voting_results_published, 1);

    // Public ballot now displays published banner
    const resBallot = await app.inject({
      method: 'GET',
      url: '/vote',
    });
    assert.equal(resBallot.statusCode, 200);
    assert.match(resBallot.payload, /Official Community Choice Standings are Published!/i);
  });

  await t.test('6. Organizer console embeds Community Voting Intelligence table', async () => {
    const resDash = await app.inject({
      method: 'GET',
      url: '/organizer/dashboard',
      headers: {
        cookie: 'session=org_7f2a',
      },
    });

    assert.equal(resDash.statusCode, 200);
    assert.match(resDash.payload, /Community Ballot &amp; People's Choice Intelligence/i);
    assert.match(resDash.payload, /Total Ballots Cast/i);
    assert.match(resDash.payload, /Results Live/i);

    // Reset flags
    const { toggleResultsPublished, toggleVotingResultsPublished } = await import('../src/db/queries.js');
    toggleResultsPublished(false);
    toggleVotingResultsPublished(false);
  });
});
