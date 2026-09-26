import http from 'node:http';

const BASE_URL = 'http://localhost:8080';

const ROLES = {
  visitor: {
    name: 'Visitor (unauthenticated)',
    cookie: '',
    expectedNav: ['Home', 'Gallery', 'Submit', 'Ballot'],
    forbiddenNav: ['Judging', 'Pairwise', 'Console'],
  },
  participant: {
    name: 'Participant (session=usr_part_33aa)',
    cookie: 'session=usr_part_33aa',
    expectedNav: ['Home', 'Gallery', 'Submit', 'Ballot'],
    forbiddenNav: ['Judging', 'Pairwise', 'Console'],
  },
  judge: {
    name: 'Judge (session=jdg_a_91bc)',
    cookie: 'session=jdg_a_91bc',
    expectedNav: ['Home', 'Gallery', 'Ballot', 'Judging', 'Pairwise'],
    forbiddenNav: ['Submit', 'Console'],
  },
  organizer: {
    name: 'Organizer (session=org_7f2a)',
    cookie: 'session=org_7f2a',
    expectedNav: ['Home', 'Gallery', 'Submit', 'Ballot', 'Judging', 'Pairwise', 'Console'],
    forbiddenNav: [],
  },
};

const ROUTES = [
  { path: '/', name: 'Official Home Portal' },
  { path: '/projects', name: 'Gallery' },
  { path: '/projects/prj_01', name: 'Project Detail (prj_01)' },
  { path: '/projects/new', name: 'Submit New Project' },
  { path: '/vote', name: 'Community Ballot' },
  { path: '/login', name: 'Sign In Page' },
  { path: '/certificates/prj_01', name: 'Certificate (prj_01)' },
  { path: '/judge/dashboard', name: 'Judge Dashboard' },
  { path: '/judge/pairwise', name: 'Pairwise Arena' },
  { path: '/organizer/dashboard', name: 'Organizer Console' },
  { path: '/api/export.csv', name: 'CSV Export' },
  { path: '/api/organizer/audit', name: 'Audit Trail' },
  { path: '/api/judge/scores', name: 'Judge Scores API' },
];

async function fetchRoute(path, cookie = '') {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const headers = {};
    if (cookie) headers['Cookie'] = cookie;

    const req = http.request(
      url,
      {
        method: 'GET',
        headers,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            location: res.headers.location || null,
            body,
          });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

const FORBIDDEN_STRINGS = [
  'ACTIVE SESSION TOKEN',
  'Copy Token',
  'Direct Token',
  'token-code',
  'dropdown-token-box',
  'usr_part_33aa',
  'prt_2e88',
  'jdg_a_91bc',
  'org_7f2a',
  'CRYPTOGRAPHIC PROVENANCE (SHA-256)',
  'SQLite 3 (WAL mode)',
];

async function runAudit() {
  console.log('===============================================================');
  console.log(' DOGFOOD 2026 ROUTE AUDIT & ROLE-BASED VERIFICATION MATRIX');
  console.log('===============================================================\n');

  const matrix = {};
  let totalChecks = 0;
  let passedChecks = 0;
  const issues = [];

  function check(desc, condition, failDetail = '') {
    totalChecks++;
    if (condition) {
      passedChecks++;
      return true;
    } else {
      issues.push(`FAIL: ${desc} ${failDetail ? `(${failDetail})` : ''}`);
      return false;
    }
  }

  for (const [roleKey, role] of Object.entries(ROLES)) {
    matrix[roleKey] = {};
    console.log(`\n-------------------------------------------------------------`);
    console.log(`Auditing Role: ${role.name}`);
    console.log(`-------------------------------------------------------------`);

    for (const route of ROUTES) {
      const res = await fetchRoute(route.path, role.cookie);
      matrix[roleKey][route.path] = {
        status: res.statusCode,
        location: res.location,
        isHtml: (res.headers['content-type'] || '').includes('text/html'),
      };

      // 1. Check HTTP Status
      if (route.path === '/judge/dashboard' || route.path === '/judge/pairwise') {
        if (roleKey === 'visitor' || roleKey === 'participant') {
          check(
            `[${roleKey}] ${route.path} redirects or blocks`,
            res.statusCode === 302 || res.statusCode === 403 || res.statusCode === 401,
            `status=${res.statusCode}, loc=${res.location}`
          );
        } else {
          check(
            `[${roleKey}] ${route.path} accessible`,
            res.statusCode === 200,
            `status=${res.statusCode}`
          );
        }
      } else if (route.path === '/organizer/dashboard' || route.path === '/api/export.csv' || route.path === '/api/organizer/audit') {
        if (roleKey === 'organizer') {
          check(
            `[${roleKey}] ${route.path} accessible`,
            res.statusCode === 200,
            `status=${res.statusCode}`
          );
        } else {
          check(
            `[${roleKey}] ${route.path} blocked or redirected`,
            res.statusCode === 302 || res.statusCode === 403 || res.statusCode === 401,
            `status=${res.statusCode}`
          );
        }
      } else if (route.path === '/api/judge/scores') {
        if (roleKey === 'judge' || roleKey === 'organizer') {
          check(
            `[${roleKey}] /api/judge/scores accessible`,
            res.statusCode === 200,
            `status=${res.statusCode}`
          );
        } else {
          check(
            `[${roleKey}] /api/judge/scores blocked`,
            res.statusCode === 401 || res.statusCode === 403,
            `status=${res.statusCode}`
          );
        }
      } else if (route.path === '/certificates/prj_01') {
        if (roleKey === 'visitor') {
          check(
            `[${roleKey}] /certificates/prj_01 redirects to login (302)`,
            res.statusCode === 302,
            `status=${res.statusCode}, loc=${res.location}`
          );
        } else if (roleKey === 'participant' || roleKey === 'organizer') {
          check(
            `[${roleKey}] /certificates/prj_01 accessible for authorized user (200)`,
            res.statusCode === 200,
            `status=${res.statusCode}`
          );
        } else {
          // Judge is not on team tm_01 and not an organizer
          check(
            `[${roleKey}] /certificates/prj_01 blocked for non-team judge (403)`,
            res.statusCode === 403,
            `status=${res.statusCode}`
          );
        }
      } else {
        // Public routes
        check(
          `[${roleKey}] ${route.path} accessible (200)`,
          res.statusCode === 200,
          `status=${res.statusCode}`
        );
      }

      // If page returns HTML, check navigation links and slop
      if (res.statusCode === 200 && matrix[roleKey][route.path].isHtml) {
        // Check expected nav links
        for (const navText of role.expectedNav) {
          const hasNav = res.body.includes(`>${navText}<`) || res.body.includes(`>${navText}</a>`);
          check(
            `[${roleKey}] ${route.path} has nav '${navText}'`,
            hasNav,
            `missing nav item ${navText}`
          );
        }

        // Check forbidden nav links
        for (const navText of role.forbiddenNav) {
          const hasForbidden =
            res.body.includes(`>${navText}<`) ||
            res.body.includes(`>${navText}</a>`) ||
            res.body.includes(`>${navText} Queue`);
          check(
            `[${roleKey}] ${route.path} hides forbidden nav '${navText}'`,
            !hasForbidden,
            `unexpected forbidden nav item ${navText} visible`
          );
        }

        // Check absence of forbidden slop strings
        for (const badStr of FORBIDDEN_STRINGS) {
          const hasBadStr = res.body.includes(badStr);
          check(
            `[${roleKey}] ${route.path} no slop '${badStr}'`,
            !hasBadStr,
            `found forbidden string: ${badStr}`
          );
        }
      }
    }
  }

  // Deep targeted checks
  console.log(`\n-------------------------------------------------------------`);
  console.log(`Deep Targeted Checks (Deadline, Provenance, Login, Footer)`);
  console.log(`-------------------------------------------------------------`);

  // Check 1: Submission deadline is formatted cleanly, not raw ISO string
  const resSubmit = await fetchRoute('/projects/new');
  check(
    'Submit page formats deadline with clean human-readable date',
    resSubmit.body.includes('Sunday, March 1, 2026 at 6:00 PM UTC') ||
    resSubmit.body.includes('March 1, 2026'),
    'Deadline date text not formatted properly'
  );
  check(
    'Submit page does not leak unformatted raw ISO text in text nodes',
    !/>\s*2026-03-01T18:00:00Z\s*</.test(resSubmit.body),
    'Found unformatted raw ISO text in HTML body'
  );

  // Check 2: Project detail page has no raw 64-char hash in body
  const resDetail = await fetchRoute('/projects/prj_01');
  const hexHashRegex = />[a-f0-9]{64}</i;
  check(
    'Project detail does not display raw 64-char hex hash',
    !hexHashRegex.test(resDetail.body),
    'Found raw 64-character hash in HTML body'
  );
  check(
    'Project detail does not display certificate button to anonymous visitor',
    !resDetail.body.includes('Team Certificate'),
    'Certificate button unexpectedly visible to visitor'
  );

  // Check 3: Login page has clean tabs, no Direct Token
  const resLogin = await fetchRoute('/login');
  check(
    'Login page does not have Direct Token tab',
    !resLogin.body.includes('Direct Token') && !resLogin.body.includes('id="tab-token"'),
    'Direct Token tab still exists on login page'
  );
  check(
    'Login page has Demo Quick-Access tab',
    resLogin.body.includes('Demo Quick-Access'),
    'Demo Quick-Access tab missing'
  );

  // Check 4: Footer contains clean copyright and no debug engine leaks
  check(
    'Footer has clean copyright',
    (resSubmit.body.includes('&copy; 2026') || resSubmit.body.includes('© 2026')) &&
    !resSubmit.body.includes('SQLite 3 (WAL mode)'),
    'Footer copy mismatch'
  );

  // Check 5: Certificate page renders clean diploma when authorized
  const resCert = await fetchRoute('/certificates/prj_01', 'session=usr_part_33aa');
  check(
    'Certificate renders official title and clean cert number',
    resCert.body.includes('Certificate of Achievement') &&
    resCert.body.includes('DF26-PRJ_01-'),
    'Certificate missing standard clean text'
  );
  check(
    'No raw 64-char hash on certificate page',
    !/[a-f0-9]{64}/i.test(resCert.body),
    'Found 64-char hash on certificate page'
  );

  console.log('\n===============================================================');
  console.log(` AUDIT SUMMARY: ${passedChecks} / ${totalChecks} checks passed`);
  console.log('===============================================================');

  if (issues.length > 0) {
    console.log('\nISSUES FOUND:');
    issues.forEach((iss) => console.log('  ' + iss));
  } else {
    console.log('\nALL CHECKS PASSED PERFECTLY WITH ZERO ISSUES!');
  }

  console.log('\n--- FULL MATRIX JSON ---');
  console.log(JSON.stringify(matrix, null, 2));
}

runAudit().catch(console.error);
