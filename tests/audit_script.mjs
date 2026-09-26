import http from 'node:http';

const BASE_URL = 'http://localhost:8080';

const ROLES = {
  visitor: {
    name: 'Visitor (unauthenticated)',
    cookie: '',
    expectedNav: ['Gallery', 'Submit', 'Ballot'],
    forbiddenNav: ['Judging', 'Pairwise', 'Console'],
  },
  participant: {
    name: 'Participant (session=usr_part_33aa)',
    cookie: 'session=usr_part_33aa',
    expectedNav: ['Gallery', 'Submit', 'Ballot'],
    forbiddenNav: ['Judging', 'Pairwise', 'Console'],
  },
  judge: {
    name: 'Judge (session=jdg_a_91bc)',
    cookie: 'session=jdg_a_91bc',
    expectedNav: ['Gallery', 'Ballot', 'Judging', 'Pairwise'],
    forbiddenNav: ['Submit', 'Console'],
  },
  organizer: {
    name: 'Organizer (session=org_7f2a)',
    cookie: 'session=org_7f2a',
    expectedNav: ['Gallery', 'Submit', 'Ballot', 'Judging', 'Pairwise', 'Console'],
    forbiddenNav: [],
  },
};

const ROUTES = [
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
            body,
            location: res.headers.location || null,
          });
        });
      }
    );

    req.on('error', reject);
    req.end();
  });
}

function parseNavLinks(html) {
  const navMatch = html.match(/<nav class="main-nav">([\s\S]*?)<\/nav>/);
  if (!navMatch) return [];

  const navHtml = navMatch[1];
  const links = [];
  const linkRegex = /<a\s+[^>]*>([^<]+)<\/a>/g;
  let match;
  while ((match = linkRegex.exec(navHtml)) !== null) {
    links.push(match[1].trim());
  }
  return links;
}

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
        const navLinks = parseNavLinks(res.body);

        // Check expected nav
        for (const exp of role.expectedNav) {
          check(
            `[${roleKey}] Navbar has "${exp}" on ${route.path}`,
            navLinks.includes(exp),
            `Actual nav: [${navLinks.join(', ')}]`
          );
        }

        // Check forbidden nav
        for (const forb of role.forbiddenNav) {
          check(
            `[${roleKey}] Navbar DOES NOT have "${forb}" on ${route.path}`,
            !navLinks.includes(forb),
            `Nav contained forbidden item "${forb}"`
          );
        }

        // Slop checks
        check(
          `[${roleKey}] No "ACTIVE SESSION TOKEN" on ${route.path}`,
          !res.body.includes('ACTIVE SESSION TOKEN') && !res.body.includes('Copy Token'),
          'Found active session token or copy token box'
        );

        check(
          `[${roleKey}] No Direct Token tab on ${route.path}`,
          !res.body.includes('Direct Token') && !res.body.includes('tab-direct'),
          'Found direct token login tab'
        );

        // Check no raw session token dump in header/navbar
        if (role.cookie) {
          const rawToken = role.cookie.split('=')[1];
          // Check that raw token doesn't appear in the rendered navbar or layout
          const navAreaMatch = res.body.match(/<header class="app-header">([\s\S]*?)<\/header>/);
          if (navAreaMatch) {
            check(
              `[${roleKey}] No raw token in header on ${route.path}`,
              !navAreaMatch[1].includes(rawToken),
              `Header contains raw token "${rawToken}"`
            );
          }
        }
      }
    }
  }

  // Specific Deep Checks
  console.log(`\n-------------------------------------------------------------`);
  console.log(`Deep Targeted Checks (Deadline, Provenance, Login, Footer)`);
  console.log(`-------------------------------------------------------------`);

  // Check 1: /projects/new deadline format
  const resNew = await fetchRoute('/projects/new');
  check(
    'Deadline is human readable',
    resNew.body.includes('Sunday, March 1, 2026 at 6:00 PM UTC') ||
    resNew.body.includes('March 1, 2026 at 6:00 PM UTC'),
    'Formatted deadline not found'
  );

  // Check visible text doesn't show raw ISO without wrapper
  const rawIsoMatch = resNew.body.match(/>\s*2026-03-01T18:00:00Z\s*</);
  check(
    'No raw ISO string visible directly in HTML text on /projects/new',
    !rawIsoMatch,
    'Raw ISO string found inside HTML text'
  );

  // Check 2: Project detail provenance hash
  const resDetail = await fetchRoute('/projects/prj_01');
  const has64Hex = /[a-f0-9]{64}/i.test(resDetail.body);
  check(
    'No 64-char hex hashes on project detail page /projects/prj_01',
    !has64Hex,
    'Found 64-char hex string on project detail'
  );

  // Check 3: Login page tabs
  const resLogin = await fetchRoute('/login');
  check(
    'Login page has no Direct Token tab',
    !resLogin.body.includes('Direct Token') && !resLogin.body.includes('tab-direct'),
    'Found Direct Token tab'
  );
  check(
    'Login page has Demo Quick-Access tab',
    resLogin.body.includes('Demo Quick-Access'),
    'Demo Quick-Access tab missing'
  );
  check(
    'Login page has Email & Password tab',
    resLogin.body.includes('Email &amp; Password') || resLogin.body.includes('Email & Password'),
    'Email & Password tab missing'
  );
  check(
    'Login persona cards do NOT show raw internal user IDs like usr_part_33aa or usr_part to users',
    !resLogin.body.includes('usr_part_33aa') && !resLogin.body.includes('usr_part<'),
    'Found raw user ID in login UI'
  );

  // Check 4: Footer verification
  check(
    'Footer has clean copyright & user-facing copy',
    resDetail.body.includes('&copy; 2026 Sample Hackathon. All rights reserved.') &&
    resDetail.body.includes('Built for transparent peer evaluation'),
    'Footer copy mismatch'
  );

  // Check 5: Certificate page renders clean
  const resCert = await fetchRoute('/certificates/prj_01');
  check(
    'Certificate renders official title and clean cert number',
    resCert.body.includes('Official Record of Participation') &&
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
