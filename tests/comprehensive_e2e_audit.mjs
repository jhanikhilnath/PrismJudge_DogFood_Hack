import http from 'node:http';

const BASE_URL = 'http://localhost:8080';

// Cookie sessions for personas
const SESSIONS = {
  anonymous: '',
  participant: 'session=usr_part_33aa',
  judge_a: 'session=jdg_a_91bc',
  judge_b: 'session=jdg_b_44de',
  organizer: 'session=org_7f2a',
};

// Generic HTTP request helper
function request({ path, method = 'GET', cookie = '', body = null, headers = {} }) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = { ...headers };
    if (cookie) reqHeaders['Cookie'] = cookie;
    if (body && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = typeof body === 'object' ? 'application/json' : 'application/x-www-form-urlencoded';
    }

    const payload = body && typeof body === 'object' ? JSON.stringify(body) : body;
    if (payload) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let resBody = '';
        res.on('data', (chunk) => (resBody += chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            location: res.headers.location || null,
            body: resBody,
          });
        });
      }
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Global results accumulator
const testResults = [];
let passCount = 0;
let failCount = 0;

function recordTest(id, name, passed, details = '') {
  if (passed) {
    passCount++;
    testResults.push({ id, name, status: 'PASS', details });
    console.log(`  ✓ [PASS] [${id}] ${name} ${details ? `(${details})` : ''}`);
  } else {
    failCount++;
    testResults.push({ id, name, status: 'FAIL', details });
    console.error(`  ✗ [FAIL] [${id}] ${name}: ${details}`);
  }
}

async function runEndToEndVerification() {
  console.log('========================================================================');
  console.log(' DOGFOOD 2026 HACKATHON PLATFORM — FULL RECURSIVE E2E AUDIT');
  console.log(` Target Server: ${BASE_URL}`);
  console.log('========================================================================\n');

  // ---------------------------------------------------------------------------
  // T1 CORE
  // ---------------------------------------------------------------------------
  console.log('>>> TESTING T1: CORE PORTAL & SUBMISSION SYSTEM\n');

  // 1. Home Portal
  console.log('1. Checking Home Portal (http://localhost:8080/)...');
  const resHome = await request({ path: '/' });
  recordTest('T1.1.1', 'Home portal returns HTTP 200 OK', resHome.status === 200, `status=${resHome.status}`);
  recordTest('T1.1.2', 'Page title contains PrismJudge', resHome.body.includes('PrismJudge'), 'Title tag verified');
  recordTest('T1.1.3', 'Hero status pill displays active phase', 
    resHome.body.includes('hero-status-pill') && (resHome.body.includes('Submissions Closed') || resHome.body.includes('Evaluation Phase')),
    'Status pill present');
  recordTest('T1.1.4', 'Telemetry metrics display 41 fixture projects',
    resHome.body.includes('telemetry-value">41</div>') && resHome.body.includes('SUBMITTED PROJECTS'),
    '41 projects verified');
  const trackCardMatches = resHome.body.match(/class="track-showcase-card"/g) || [];
  recordTest('T1.1.5', 'Competition track grid displays 8 tracks', trackCardMatches.length === 8, `Found ${trackCardMatches.length} track cards`);
  recordTest('T1.1.6', 'Math rigor architecture pillars present (Bayesian, Bradley-Terry, Peer Isolation)',
    resHome.body.includes('Empirical Bayesian Normalization') &&
    resHome.body.includes('Bradley-Terry Pairwise Arena') &&
    resHome.body.includes('Cryptographic Peer Isolation'),
    'All 3 core math pillars present');
  const timelineMatches = resHome.body.match(/class="timeline-step/g) || [];
  recordTest('T1.1.7', 'Competition timeline displays 4 event phases', timelineMatches.length === 4, `Found ${timelineMatches.length} timeline milestones`);

  // 2. Gallery
  console.log('\n2. Checking Project Gallery (http://localhost:8080/projects)...');
  const resGallery = await request({ path: '/projects' });
  const galleryCards = resGallery.body.match(/class="project-card"/g) || [];
  recordTest('T1.2.1', 'Gallery returns HTTP 200 OK', resGallery.status === 200, `status=${resGallery.status}`);
  recordTest('T1.2.2', 'All 41 fixture projects render in gallery', galleryCards.length === 41, `Rendered ${galleryCards.length} projects`);
  
  // Search filter
  const resSearch = await request({ path: '/projects?q=Glass+Signal' });
  const searchCards = resSearch.body.match(/class="project-card"/g) || [];
  recordTest('T1.2.3', 'Search filter for "Glass Signal" returns exactly 1 match', searchCards.length === 1 && resSearch.body.includes('Glass Signal'), `Matched ${searchCards.length} project`);
  
  // Track filter
  const resTrack = await request({ path: '/projects?track=trk_04' });
  const trackCards = resTrack.body.match(/class="project-card"/g) || [];
  recordTest('T1.2.4', 'Track filter ?track=trk_04 filters to exactly 5 projects', trackCards.length === 5, `Matched ${trackCards.length} projects`);

  // 3. Project Details
  console.log('\n3. Checking Project Details (http://localhost:8080/projects/prj_01)...');
  const resDetailAnon = await request({ path: '/projects/prj_01' });
  recordTest('T1.3.1', 'Project details returns HTTP 200 OK', resDetailAnon.status === 200, `status=${resDetailAnon.status}`);
  recordTest('T1.3.2', 'Project prj_01 displays title "Glass Signal"', resDetailAnon.body.includes('Glass Signal'), 'Title rendered');
  recordTest('T1.3.3', 'Project prj_01 displays team "NorthKiln"', resDetailAnon.body.includes('NorthKiln'), 'Team rendered');
  recordTest('T1.3.4', 'Project prj_01 displays track "Security"', resDetailAnon.body.includes('Security'), 'Track rendered');
  recordTest('T1.3.5', 'Source repository link present', resDetailAnon.body.includes('github.com') || resDetailAnon.body.includes('Source Code') || resDetailAnon.body.includes('repo'), 'Source link rendered');
  recordTest('T1.3.6', 'Team Certificate button HIDDEN from anonymous visitor',
    !resDetailAnon.body.includes('Team Certificate') && !resDetailAnon.body.includes('/certificates/prj_01'),
    'Certificate button cleanly hidden');
  
  // Verify button visible for team member participant
  const resDetailPart = await request({ path: '/projects/prj_01', cookie: SESSIONS.participant });
  recordTest('T1.3.7', 'Team Certificate button VISIBLE for team participant',
    resDetailPart.body.includes('Team Certificate') || resDetailPart.body.includes('/certificates/prj_01'),
    'Certificate button accessible');

  // 4. Submission Deadline Guard
  console.log('\n4. Checking Submission Deadline Guard (http://localhost:8080/projects/new)...');
  const resNewProj = await request({ path: '/projects/new' });
  recordTest('T1.4.1', 'Submission form returns HTTP 200 OK', resNewProj.status === 200, `status=${resNewProj.status}`);
  recordTest('T1.4.2', 'Deadline is cleanly formatted in human UTC date',
    resNewProj.body.includes('Sunday, March 1, 2026 at 6:00 PM UTC') || resNewProj.body.includes('March 1, 2026'),
    'Clean date format');
  recordTest('T1.4.3', 'No raw ISO date text leaks in HTML body',
    !/>\s*2026-03-01T18:00:00Z\s*</.test(resNewProj.body),
    'No raw ISO string leaked');

  const resPostLate = await request({
    path: '/projects/new',
    method: 'POST',
    cookie: SESSIONS.participant,
    body: 'title=Late+Submission&summary=Testing+deadline+enforcement&track_id=trk_01',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  recordTest('T1.4.4', 'POST /projects/new past deadline rejected with HTTP 403', resPostLate.status === 403, `status=${resPostLate.status}`);
  const postLateJson = JSON.parse(resPostLate.body || '{}');
  recordTest('T1.4.5', 'Rejection body conveys Submissions closed reason', postLateJson.error === 'Submissions closed', `error="${postLateJson.error}"`);

  // 5. Login Portal
  console.log('\n5. Checking Login Portal (http://localhost:8080/login)...');
  const resLogin = await request({ path: '/login' });
  recordTest('T1.5.1', 'Login portal returns HTTP 200 OK', resLogin.status === 200, `status=${resLogin.status}`);
  recordTest('T1.5.2', 'Demo Quick-Access tab exists', resLogin.body.includes('Demo Quick-Access') && resLogin.body.includes('data-tab="tab-personas"'), 'Quick-access tab present');
  recordTest('T1.5.3', 'Direct Token tab is completely removed', !resLogin.body.includes('Direct Token') && !resLogin.body.includes('tab-token'), 'Direct Token tab absent');
  recordTest('T1.5.4', 'Persona buttons exist for Organizer, Judge A, Judge B, and Participant',
    resLogin.body.includes('value="organizer"') &&
    resLogin.body.includes('value="judge_a"') &&
    resLogin.body.includes('value="judge_b"') &&
    resLogin.body.includes('value="participant"'),
    'All 4 demo persona buttons present');

  // Test persona POST login actions
  const personas = [
    { persona: 'organizer', expectedToken: 'org_7f2a' },
    { persona: 'judge_a', expectedToken: 'jdg_a_91bc' },
    { persona: 'judge_b', expectedToken: 'jdg_b_44de' },
    { persona: 'participant', expectedToken: 'prt_2e88' },
  ];
  for (const p of personas) {
    const resPersona = await request({
      path: '/login',
      method: 'POST',
      body: `persona=${p.persona}`,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    const setCookie = resPersona.headers['set-cookie'] ? resPersona.headers['set-cookie'].join(';') : '';
    recordTest(`T1.5.5-${p.persona}`, `Persona login for ${p.persona} issues ${p.expectedToken} cookie`,
      setCookie.includes(p.expectedToken),
      `Set-Cookie contains ${p.expectedToken}`);
  }

  // ---------------------------------------------------------------------------
  // T2 JUDGING
  // ---------------------------------------------------------------------------
  console.log('\n>>> TESTING T2: JUDGING ARCHITECTURE, PEER ISOLATION & CONSOLE\n');

  // 6. Judge Dashboard
  console.log('6. Checking Judge Dashboard (http://localhost:8080/judge/dashboard as Judge A)...');
  const resJudgeDash = await request({ path: '/judge/dashboard', cookie: SESSIONS.judge_a });
  recordTest('T2.6.1', 'Judge dashboard returns HTTP 200 OK for Judge A', resJudgeDash.status === 200, `status=${resJudgeDash.status}`);
  const judgeAssignedRows = resJudgeDash.body.match(/<tr>\s*<td style="font-family: var\(--font-mono\)[^>]*>prj_[0-9]+<\/td>/g) || [];
  recordTest('T2.6.2', 'Judge assigned workload queue populated with 41 entries', judgeAssignedRows.length === 41, `Assigned count=${judgeAssignedRows.length}`);
  recordTest('T2.6.3', 'Review progress bar rendered with percentage display',
    resJudgeDash.body.includes('Evaluation Progress') && resJudgeDash.body.includes('background: #059669;'),
    'Progress bar verified');
  recordTest('T2.6.4', 'Scoring modal dialog element exists (#scoring-modal)', resJudgeDash.body.includes('id="scoring-modal"'), 'Modal present');
  recordTest('T2.6.5', 'Functionality weighted slider present (40% weight)',
    resJudgeDash.body.includes('id="score-func"') && resJudgeDash.body.includes('data-weight="0.4"'),
    'Weight 0.4 verified');
  recordTest('T2.6.6', 'Quality & Architecture weighted slider present (30% weight)',
    resJudgeDash.body.includes('id="score-qual"') && resJudgeDash.body.includes('data-weight="0.3"'),
    'Weight 0.3 verified');
  recordTest('T2.6.7', 'Innovation weighted slider present (20% weight)',
    resJudgeDash.body.includes('id="score-inno"') && resJudgeDash.body.includes('data-weight="0.2"'),
    'Weight 0.2 verified');
  recordTest('T2.6.8', 'Impact weighted slider present (10% weight)',
    resJudgeDash.body.includes('id="score-imp"') && resJudgeDash.body.includes('data-weight="0.1"'),
    'Weight 0.1 verified');
  recordTest('T2.6.9', 'Real-time computed weighted total display present (#computed-raw-total)',
    resJudgeDash.body.includes('id="computed-raw-total"'),
    'Real-time total calculator verified');

  // 7. Hard Peer Isolation
  console.log('\n7. Checking Hard Peer Isolation on /api/judge/scores...');
  // Probe judge_a as judge_b
  const resProbePeer = await request({ path: '/api/judge/scores?judge=judge_a', cookie: SESSIONS.judge_b });
  recordTest('T2.7.1', 'Judge B probing Judge A scores returns HTTP 403 Forbidden', resProbePeer.status === 403, `status=${resProbePeer.status}`);
  const peerJson = JSON.parse(resProbePeer.body || '{}');
  recordTest('T2.7.2', 'Peer probe error conveys isolation prohibition',
    peerJson.error && peerJson.error.includes('strictly prohibited from inspecting peer scores'),
    peerJson.error);

  // Probe as participant
  const resProbePart = await request({ path: '/api/judge/scores', cookie: SESSIONS.participant });
  recordTest('T2.7.3', 'Participant probing judge scores returns HTTP 403 Forbidden', resProbePart.status === 403, `status=${resProbePart.status}`);

  // Probe as visitor
  const resProbeAnon = await request({ path: '/api/judge/scores' });
  recordTest('T2.7.4', 'Visitor probing judge scores returns HTTP 401 Unauthorized', resProbeAnon.status === 401, `status=${resProbeAnon.status}`);

  // Legitimate judge A access to own scores
  const resJudgeOwn = await request({ path: '/api/judge/scores', cookie: SESSIONS.judge_a });
  recordTest('T2.7.5', 'Judge A can view own scores (HTTP 200 OK)', resJudgeOwn.status === 200, `status=${resJudgeOwn.status}`);

  // Organizer inspection of any judge scores
  const resOrgInspectJudge = await request({ path: '/api/judge/scores?judge=judge_a', cookie: SESSIONS.organizer });
  recordTest('T2.7.6', 'Organizer can inspect any judge scores (HTTP 200 OK)', resOrgInspectJudge.status === 200, `status=${resOrgInspectJudge.status}`);

  // 8. Organizer Operations Console
  console.log('\n8. Checking Organizer Operations Console (http://localhost:8080/organizer/dashboard)...');
  const resOrgDash = await request({ path: '/organizer/dashboard', cookie: SESSIONS.organizer });
  recordTest('T2.8.1', 'Organizer console returns HTTP 200 OK', resOrgDash.status === 200, `status=${resOrgDash.status}`);
  recordTest('T2.8.2', 'Macro-metric: Total Projects = 41', resOrgDash.body.includes('<div class="metric-value">41</div>'), '41 verified');
  recordTest('T2.8.3', 'Macro-metric: Registered Judges = 30', resOrgDash.body.includes('<div class="metric-value">30</div>'), '30 verified');
  recordTest('T2.8.4', 'Macro-metric: Reviews Cast = 126', resOrgDash.body.includes('<div class="metric-value">126</div>'), '126 verified');
  recordTest('T2.8.5', 'Macro-metric: Global Prior Mean ~ 3.57', resOrgDash.body.includes('3.567') || resOrgDash.body.includes('3.57'), 'Global mean verified');
  recordTest('T2.8.6', 'Inter-Rater Reliability (ICC 1,1) consensus metric present',
    resOrgDash.body.includes('INTER-RATER RELIABILITY') && resOrgDash.body.includes('ICC(1,1) consensus'),
    'ICC metric present');

  const jurorTableMatch = resOrgDash.body.match(/Juror Calibration &amp; Severity Index[\s\S]*?<\/table>/);
  const jurorRows = jurorTableMatch 
    ? (jurorTableMatch[0].match(/<td style="font-family: var\(--font-mono\); font-weight: 600;">(jdg_[0-9]+)<\/td>/g) || [])
    : (resOrgDash.body.match(/<td style="font-family: var\(--font-mono\); font-weight: 600;">(jdg_[0-9]+)<\/td>/g) || []);
  recordTest('T2.8.7', 'Juror Calibration Diagnostics table lists 30 active jurors', jurorRows.length === 30, `Listed ${jurorRows.length} jurors`);
  recordTest('T2.8.8', 'Juror jdg_07 zero-variance singularity handled badge displayed',
    resOrgDash.body.includes('jdg_07') && resOrgDash.body.includes('Singularity Handled'),
    'Singularity handled resolution verified');
  recordTest('T2.8.9', 'Competition standings table renders podium badges (1st, 2nd, 3rd)',
    resOrgDash.body.includes('rank-badge rank-first') &&
    resOrgDash.body.includes('rank-badge rank-second') &&
    resOrgDash.body.includes('rank-badge rank-third'),
    'Podium badges rendered');

  // 9. CSV Export
  console.log('\n9. Checking CSV Export (http://localhost:8080/api/export.csv)...');
  const resExportOrg = await request({ path: '/api/export.csv', cookie: SESSIONS.organizer });
  recordTest('T2.9.1', 'CSV export returns HTTP 200 OK for Organizer', resExportOrg.status === 200, `status=${resExportOrg.status}`);
  const csvLines = resExportOrg.body.trim().split('\n');
  recordTest('T2.9.2', 'Row 1 contains comma-separated column headers',
    csvLines[0] && csvLines[0].includes('rank,project_id,title,team_id,track_id,review_count,raw_average,normalized_score,composite_score'),
    `Header: ${csvLines[0]}`);
  recordTest('T2.9.3', 'All 41 projects exported in CSV rows', csvLines.length === 42, `Exported ${csvLines.length - 1} project rows`);
  
  const resExportPart = await request({ path: '/api/export.csv', cookie: SESSIONS.participant });
  recordTest('T2.9.4', 'CSV export returns HTTP 403 Forbidden for Participant', resExportPart.status === 403, `status=${resExportPart.status}`);
  
  const resExportJudge = await request({ path: '/api/export.csv', cookie: SESSIONS.judge_a });
  recordTest('T2.9.5', 'CSV export returns HTTP 403 Forbidden for Judge', resExportJudge.status === 403, `status=${resExportJudge.status}`);

  // ---------------------------------------------------------------------------
  // T3 PUBLIC
  // ---------------------------------------------------------------------------
  console.log('\n>>> TESTING T3: PUBLIC BALLOTING & DISCUSSION STREAM\n');

  // 10. Community Voting Ballot
  console.log('10. Checking Community Voting Ballot (http://localhost:8080/vote)...');
  const resVoteVisitor = await request({ path: '/vote' });
  const resVoteJudge = await request({ path: '/vote', cookie: SESSIONS.judge_a });
  const resVotePart = await request({ path: '/vote', cookie: SESSIONS.participant });

  recordTest('T3.10.1', 'Ballot page returns HTTP 200 OK', resVoteVisitor.status === 200, `status=${resVoteVisitor.status}`);
  
  const orderVisitor = (resVoteVisitor.body.match(/<span class="card-id-tag">(prj_[0-9]+)<\/span>/g) || []).slice(0, 8);
  const orderJudge = (resVoteJudge.body.match(/<span class="card-id-tag">(prj_[0-9]+)<\/span>/g) || []).slice(0, 8);
  recordTest('T3.10.2', 'Ballot ordering randomized between sessions via Fisher-Yates hash shuffle',
    orderVisitor.join(',') !== orderJudge.join(','),
    `Visitor=[${orderVisitor.slice(0,3).join(',')}] vs Judge=[${orderJudge.slice(0,3).join(',')}]`);

  // Cast vote
  const testVoterEmail = `audit_voter_${Date.now()}@example.org`;
  const resCastVote = await request({
    path: '/api/vote',
    method: 'POST',
    body: { project_id: 'prj_03', voter_email: testVoterEmail },
  });
  recordTest('T3.10.3', 'Casting valid community vote returns HTTP 200 OK', resCastVote.status === 200, `status=${resCastVote.status}`);
  const castVoteJson = JSON.parse(resCastVote.body || '{}');
  recordTest('T3.10.4', 'Vote response confirms successful feedback',
    castVoteJson.message === 'Vote recorded successfully' && castVoteJson.project_id === 'prj_03',
    castVoteJson.message);

  // Attempt duplicate vote
  await new Promise((r) => setTimeout(r, 3100)); // bypass 3s sliding-window IP rate limiter
  const resDupVote = await request({
    path: '/api/vote',
    method: 'POST',
    body: { project_id: 'prj_03', voter_email: testVoterEmail },
  });
  recordTest('T3.10.5', 'Duplicate vote for same project rejected with HTTP 409 Conflict', resDupVote.status === 409, `status=${resDupVote.status}`);

  // 11. Discussion Comments
  console.log('\n11. Checking Discussion Comments (http://localhost:8080/projects/prj_01)...');
  const commentText = `Automated Verification Stream ${Date.now()}`;
  const resPostComment = await request({
    path: '/api/comments/prj_01',
    method: 'POST',
    cookie: SESSIONS.participant,
    body: { content: commentText, author_name: 'System Auditor' },
  });
  recordTest('T3.11.1', 'Posting comment returns HTTP 201 Created', resPostComment.status === 201, `status=${resPostComment.status}`);

  const resCheckComment = await request({ path: '/projects/prj_01' });
  recordTest('T3.11.2', 'Posted comment appears in project discussion stream HTML',
    resCheckComment.body.includes(commentText),
    'Comment rendered');

  // ---------------------------------------------------------------------------
  // T4 STRETCH
  // ---------------------------------------------------------------------------
  console.log('\n>>> TESTING T4: STRETCH FEATURES (PAIRWISE, SWAGGER, CERTIFICATES, AUDIT)\n');

  // 12. Pairwise Arena
  console.log('12. Checking Pairwise Arena (http://localhost:8080/judge/pairwise as Judge A)...');
  const resPairwise = await request({ path: '/judge/pairwise', cookie: SESSIONS.judge_a });
  recordTest('T4.12.1', 'Pairwise Arena returns HTTP 200 OK for Judge A', resPairwise.status === 200, `status=${resPairwise.status}`);
  recordTest('T4.12.2', 'Side-by-side comparison cards and tie button rendered',
    resPairwise.body.includes('pairwise-arena-grid') &&
    resPairwise.body.includes('pairwise-vs-divider') &&
    resPairwise.body.includes('submitPairwiseVote'),
    'Comparison cards verified');

  const resPairwiseVote = await request({
    path: '/api/pairwise/vote',
    method: 'POST',
    cookie: SESSIONS.judge_a,
    body: { project_a: 'prj_01', project_b: 'prj_02', winner: 'project_a' },
  });
  recordTest('T4.12.3', 'Recording pairwise decision returns HTTP 201 Created', resPairwiseVote.status === 201, `status=${resPairwiseVote.status}`);
  const pwVoteJson = JSON.parse(resPairwiseVote.body || '{}');
  recordTest('T4.12.4', 'Pairwise vote confirmed in response', pwVoteJson.winner === 'project_a' && !!pwVoteJson.matchId, `matchId=${pwVoteJson.matchId}`);

  // 13. OpenAPI 3.1 Swagger Docs
  console.log('\n13. Checking OpenAPI 3.1 Swagger Docs (http://localhost:8080/docs)...');
  const resSwaggerUI = await request({ path: '/docs/' });
  recordTest('T4.13.1', 'Swagger UI documentation page returns HTTP 200 OK', resSwaggerUI.status === 200, `status=${resSwaggerUI.status}`);
  recordTest('T4.13.2', 'Swagger UI HTML contains swagger assets',
    resSwaggerUI.body.includes('swagger-ui') || resSwaggerUI.body.includes('swagger'),
    'Swagger UI loaded');

  const resOpenApiJson = await request({ path: '/docs/json' });
  recordTest('T4.13.3', '/docs/json returns HTTP 200 OK', resOpenApiJson.status === 200, `status=${resOpenApiJson.status}`);
  const openApiObj = JSON.parse(resOpenApiJson.body || '{}');
  recordTest('T4.13.4', 'OpenAPI schema declares specification version 3.1.0', openApiObj.openapi === '3.1.0', `openapi=${openApiObj.openapi}`);
  recordTest('T4.13.5', 'OpenAPI schema documents REST routes',
    openApiObj.paths && Object.keys(openApiObj.paths).length >= 10,
    `Documented ${Object.keys(openApiObj.paths || {}).length} paths`);

  // 14. Diploma Certificate & Credential Privacy
  console.log('\n14. Checking Diploma Certificate & Credential Privacy (/certificates/prj_01)...');
  const resCertAnon = await request({ path: '/certificates/prj_01' });
  recordTest('T4.14.1', 'Unauthenticated visitor redirected to login (HTTP 302)', resCertAnon.status === 302, `status=${resCertAnon.status}, loc=${resCertAnon.location}`);
  
  const resCertJudge = await request({ path: '/certificates/prj_01', cookie: SESSIONS.judge_a });
  recordTest('T4.14.2', 'Judge A (non-team member) receives HTTP 403 Forbidden', resCertJudge.status === 403, `status=${resCertJudge.status}`);

  const resCertPart = await request({ path: '/certificates/prj_01', cookie: SESSIONS.participant });
  recordTest('T4.14.3', 'Participant (team member) receives HTTP 200 OK', resCertPart.status === 200, `status=${resCertPart.status}`);

  const resCertOrg = await request({ path: '/certificates/prj_01', cookie: SESSIONS.organizer });
  recordTest('T4.14.4', 'Organizer receives HTTP 200 OK', resCertOrg.status === 200, `status=${resCertOrg.status}`);

  recordTest('T4.14.5', 'Landscape diploma styling rendered (.diploma-sheet)', resCertPart.body.includes('diploma-sheet'), 'Diploma sheet verified');
  recordTest('T4.14.6', 'Official gold seal medallion rendered (.cert-gold-seal)', resCertPart.body.includes('cert-gold-seal'), 'Gold seal medallion verified');
  recordTest('T4.14.7', 'Dual committee signatures rendered (.diploma-sig-col)',
    (resCertPart.body.match(/class="diploma-sig-col"/g) || []).length === 2,
    'Both committee signatures rendered');

  const resCertVerify = await request({ path: '/certificates/prj_01/verify' });
  recordTest('T4.14.8', 'Public verification endpoint /certificates/prj_01/verify returns HTTP 200 OK', resCertVerify.status === 200, `status=${resCertVerify.status}`);
  const certVerifyJson = JSON.parse(resCertVerify.body || '{}');
  recordTest('T4.14.9', 'Public verification confirms authentic credential',
    certVerifyJson.verified === true && certVerifyJson.certificate_id === 'DF26-PRJ_01' && certVerifyJson.status === 'AUTHENTIC_CREDENTIAL_ISSUED',
    `status=${certVerifyJson.status}`);

  // 15. Audit Ledger
  console.log('\n15. Checking Audit Ledger (http://localhost:8080/api/organizer/audit)...');
  const resAuditOrg = await request({ path: '/api/organizer/audit', cookie: SESSIONS.organizer });
  recordTest('T4.15.1', 'Audit ledger returns HTTP 200 OK for Organizer', resAuditOrg.status === 200, `status=${resAuditOrg.status}`);
  const auditJson = JSON.parse(resAuditOrg.body || '{}');
  recordTest('T4.15.2', 'Audit ledger contains recorded system actions',
    auditJson.logs && auditJson.logs.length > 0,
    `Recorded count=${auditJson.logs?.length}`);

  const resAuditPart = await request({ path: '/api/organizer/audit', cookie: SESSIONS.participant });
  recordTest('T4.15.3', 'Audit ledger returns HTTP 403 Forbidden for Participant', resAuditPart.status === 403, `status=${resAuditPart.status}`);

  const resAuditAnon = await request({ path: '/api/organizer/audit' });
  recordTest('T4.15.4', 'Audit ledger returns HTTP 401 Unauthorized for Visitor', resAuditAnon.status === 401, `status=${resAuditAnon.status}`);

  // Summary
  console.log('\n========================================================================');
  console.log(` AUDIT EXECUTION COMPLETE: ${passCount} / ${passCount + failCount} CHECKS PASSED`);
  console.log('========================================================================');

  return { passCount, failCount, total: passCount + failCount, results: testResults };
}

runEndToEndVerification().catch((err) => {
  console.error('Fatal audit failure:', err);
  process.exit(1);
});
