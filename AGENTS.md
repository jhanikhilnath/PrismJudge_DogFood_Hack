# AGENTS.md — System Architecture, Agent Guidelines & Invariants
> **Autonomous Agent Operating Manual for DOGFOOD 2026**  
> Target: Grand Prize ($800 USD) & Best Judging Engine ($100 USD)  
> Repository: [https://github.com/jhanikhilnath/dogfood_hack.git](https://github.com/jhanikhilnath/dogfood_hack.git)

---

## 1. Project Overview & Identity

**DOGFOOD 2026** is a production-grade, self-hostable, 100% offline-first hackathon submission, evaluation, and normalization platform built in **Node.js 22 LTS, TypeScript, Fastify v5, and embedded SQLite 3 (WAL mode)**.

### Core Philosophy: The One-Command Rule
```bash
docker compose up
```
The portal must boot in under 1 second with the physical host network disconnected, mount the local SQLite database, seed all 41 projects, 30 judges, 8 tracks, and 126 reviews from `fixtures.json`, and serve traffic on `http://localhost:8080`.

---

## 2. Directory Layout & File Responsibilities

```
.
├── .dogfood.toml               # Official competition acceptance manifest (claimed = ["T1", "T2"])
├── run.py                      # Official competition acceptance verification runner
├── fixtures.json               # Seed fixtures (41 projects, 30 judges, 8 tracks, 126 scores)
├── AGENTS.md                   # This agent operating manual
├── CONTEXT.md                  # Living inter-agent handoff ledger & comprehensive tour
├── README.md                   # Primary public repository documentation
├── ARCHITECTURE.md             # System architecture & Fastify pipeline lifecycle
├── JUDGING.md                  # Mathematical proofs for Bayesian shrinkage & Bradley-Terry
├── SECURITY.md                 # Formal threat model, IDOR defenses, and penetration test logs
├── DATA-MODEL.md               # Relational database schema & entity descriptions
├── docs/
│   └── DECISIONS.md            # Architecture Decision Records (ADR) with deep rationales
├── src/
│   ├── index.ts                # Application entry point & banner output
│   ├── app.ts                  # Fastify instance builder, plugins, and root route
│   ├── config.ts               # Environment configuration & constants
│   ├── db/
│   │   ├── index.ts            # node:sqlite DatabaseSync singleton with WAL mode
│   │   ├── schema.ts           # DDL table creation scripts
│   │   └── seed.ts             # Idempotent fixtures ingestion & persona seed sessions
│   ├── core/
│   │   ├── auth.ts             # Session token generation & PBKDF2 hashing
│   │   ├── rbac.ts             # Fastify preHandler hooks for role resolution & peer isolation
│   │   └── audit.ts            # Immutable append-only audit ledger
│   ├── engine/
│   │   ├── normalization.ts    # Empirical Bayesian Shrinkage Z-score & juror diagnostics
│   │   ├── pairwise.ts         # Bradley-Terry Minorization-Maximization (MM) solver
│   │   └── ranking.ts          # Composite leaderboard & RFC 4180 CSV generator
│   ├── routes/
│   │   ├── auth.ts             # Sign in, sign out, persona switching
│   │   ├── projects.ts         # Public gallery, project submission & deadline guard
│   │   ├── judging.ts          # Judge dashboard, rubric slider scoring, peer isolation
│   │   ├── pairwise.ts         # Head-to-head pairwise showdown arena
│   │   ├── organizer.ts        # Operations console, live standings, CSV export
│   │   ├── community.ts        # Randomized community ballot & rate-limited comments
│   │   └── webhooks.ts         # Private diploma certificates & public verification
│   ├── views/                  # Server-Side Rendered (SSR) EJS templates
│   │   ├── layout.ejs          # Master layout with role-based navigation & profile menu
│   │   ├── home.ejs            # Editorial welcome portal with tracks & telemetry
│   │   ├── gallery.ejs         # Searchable, filterable project grid & spotlight card
│   │   ├── project_detail.ejs  # Technical breakdown, discussion, and gated cert button
│   │   ├── submit.ejs          # Project submission form with local/UTC deadline time
│   │   ├── judge_dashboard.ejs # Assigned workload queue & interactive scoring modal
│   │   ├── pairwise.ejs        # Side-by-side comparison arena
│   │   ├── organizer_dash.ejs  # Live console with Bayesian proof & juror calibration
│   │   ├── voting.ejs          # Community ballot with Fisher-Yates hash shuffle
│   │   ├── login.ejs           # Demo personas (1-click) and email/password sign-in
│   │   ├── certificate.ejs     # Landscape printable diploma with gold seal medallion
│   │   └── certificate_restricted.ejs # Polite HTTP 403 access control notice
│   └── public/
│       ├── css/styles.css      # Studio Light design system & @media print styles
│       └── js/app.js           # Progressive client script (toasts, local-time, dropdowns)
└── tests/
    ├── acceptance.test.ts      # In-memory replicate of run.py assertions
    ├── deadline.test.ts        # Submission deadline enforcement tests
    ├── csv_export.test.ts      # RFC 4180 CSV export compliance tests
    ├── normalization.test.ts   # Mathematical proof tests for Bayesian shrinkage (jdg_07)
    ├── pairwise.test.ts        # Bradley-Terry MM convergence tests
    ├── role_isolation.test.ts  # HTTP 403 peer isolation penetration tests
    ├── security_audit.test.ts  # SQL injection, timing-attack, and rate-limiting tests
    └── audit_script.mjs        # 619-assertion automated role & route matrix crawler
```

---

## 3. Seeded Persona Credentials & Tokens

The database seeds 4 distinct test personas for instant evaluation:

| Role | Name / Title | Cookie Header | User ID | Default Team / Association |
| :--- | :--- | :--- | :--- | :--- |
| **Organizer** | Lead Organizer | `Cookie: session=org_7f2a` | `usr_org` | Platform Administrator |
| **Judge A** | Tomas Varga | `Cookie: session=jdg_a_91bc` | `jdg_01` | Lead Technical Evaluator |
| **Judge B** | Elena Chen | `Cookie: session=jdg_b_44de` | `jdg_02` | Peer Evaluator |
| **Participant** | Sample Participant | `Cookie: session=usr_part_33aa` | `usr_part` | NorthKiln (`tm_01`, owner of `prj_01`) |
| **Participant (Alt)** | Sample Participant | `Cookie: session=prt_2e88` | `usr_part` | NorthKiln (`tm_01`, owner of `prj_01`) |

---

## 4. Role-Based Navigation & Access Control Matrix

Navigation links in `<nav class="main-nav">` and route access codes:

| Route Path | Description | Visitor | Participant | Judge | Organizer |
| :--- | :--- | :---: | :---: | :---: | :---: |
| `/` | Official Home Portal | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** |
| `/projects` | Submissions Gallery | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** |
| `/projects/:id` | Project Details | **200** | **200** | **200** | **200** |
| `/projects/new` | Submission Form | **200 (Nav)** | **200 (Nav)** | Hidden (302) | **200 (Nav)** |
| `/vote` | Community Ballot | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** | **200 (Nav)** |
| `/login` | Sign In Portal | **200** | **200** | **200** | **200** |
| `/judge/dashboard` | Judging Queue | Hidden (302) | Hidden (302) | **200 (Nav)** | **200 (Nav)** |
| `/judge/pairwise` | Pairwise Arena | Hidden (302) | Hidden (302) | **200 (Nav)** | **200 (Nav)** |
| `/organizer/dashboard`| Operations Console | Hidden (302) | Hidden (302) | Hidden (302) | **200 (Nav)** |
| `/certificates/:id` | Diploma Certificate | 302 Redirect | **200** (Own) / **403** (Peer) | **403** (Non-Team) | **200** (All) |
| `/certificates/:id/verify` | Credential Verify | **200 (JSON)** | **200 (JSON)** | **200 (JSON)** | **200 (JSON)** |
| `/api/export.csv` | RFC 4180 CSV Export | **401** | **403** | **403** | **200** |
| `/api/judge/scores` | Judge Scores API | **401** | **403** | **200** (Self) / **403** (Peer) | **200** (All) |

---

## 5. Strict Design & Anti-Slop Invariants

Any agent editing frontend templates (`src/views/`) or CSS (`src/public/css/styles.css`) **must enforce**:

1. **Studio Light Typography**:
   - Primary: `Plus Jakarta Sans` / `-apple-system`.
   - Monospace: `JetBrains Mono` for IDs, dates, metrics, and tabular figures.
   - Letter-spacing: negative tracking on large titles (`-0.03em` to `-0.04em`).
2. **Zero Technical Debris**:
   - **NEVER** expose raw session tokens (`usr_part_...`, `jdg_...`, `sess_...`) in UI text.
   - **NEVER** add "Copy Token", "Direct Token", or debug token boxes in the header or dropdowns.
   - **NEVER** render raw 64-character SHA-256 hexadecimal digests as text headers.
3. **Adaptive Time Formatting**:
   - Always render deadline timestamps as `<time class="local-time" datetime="2026-03-01T18:00:00Z">Sunday, March 1, 2026 at 6:00 PM UTC</time>`.
   - Client-side `app.js` will progressively enrich with user local browser timezone.
4. **Certificate Privacy**:
   - Participation certificates are private diplomas issued to registered team members and organizers.
   - Never place unconditional certificate buttons on public gallery cards or on other teams' project pages.
   - Unauthorized attempts must yield clean HTTP 403 (`certificate_restricted.ejs`).
5. **Print-Perfect Diplomas**:
   - Certificate uses `@media print` with landscape orientation (`@page { size: landscape; margin: 10mm; }`).
   - Automatically hides navbar, footer, buttons, and backgrounds during print.

---

## 6. Mathematical Invariants: Judging & Normalization

1. **Empirical Bayesian Shrinkage Z-Score**:
   $$\mu_j^* = \frac{n_j \bar{S}_j + m \mu_0}{n_j + m}, \quad \sigma_j^{*2} = \frac{\max(0, n_j - 1) v_j + m \sigma_0^2}{\max(1, n_j - 1) + m}, \quad \sigma_j^* = \sqrt{\sigma_j^{*2}}$$
   - Weight parameter: $m = 3.0$.
   - **Zero-variance proof**: Judge `jdg_07` ($v_j = 0$) shrinks to $\sigma_7^* = \sqrt{\frac{3(0.434)}{2 + 3}} = 0.5105 > 0$. Division by zero is mathematically impossible.
   - Scaling: $Z_{ij} = \frac{S_{ij} - \mu_j^*}{\sigma_j^*}$, $\text{Score}_{ij}^{\text{norm}} = \text{clamp}(70 + 12 \cdot Z_{ij}, 0, 100)$.
2. **Bradley-Terry Pairwise Model**:
   - Solved via iterative Minorization-Maximization (MM):
     $$\pi_i^{(t+1)} = \frac{W_i}{\sum_{j \ne i} \frac{N_{ij}}{\pi_i^{(t)} + \pi_j^{(t)}}}$$
   - Latent capability: $\lambda_i = \ln \pi_i$.
   - Elo rating: $R_i = 1500 + 400 \cdot \log_{10} \pi_i$.
3. **Inter-Rater Reliability (IRR)**:
   - Evaluated using Intraclass Correlation Coefficient ICC(1,1) across all multi-reviewed submissions.

---

## 7. Verification & Testing Commands

Before pushing any changes, every agent must execute and confirm:

```bash
# 1. Typecheck & build
npm run build

# 2. Automated test suite (36/36 tests)
npm test

# 3. Route & role verification matrix (619/619 assertions)
node tests/audit_script.mjs

# 4. Comprehensive E2E container audit (89/89 assertions)
node tests/comprehensive_e2e_audit.mjs

# 5. Rebuild & boot local Docker container
docker compose build && docker compose up -d

# 6. Official acceptance suite (7/7 PASS)
python3 run.py .dogfood.toml
```

All 6 commands must pass with zero errors.

---

## 8. Inter-Agent Communication & Living Handoff: The CONTEXT.md Rule

> **CRITICAL PROTOCOL FOR ALL AUTONOMOUS AGENTS:**  
> When multiple AI agents work consecutively on this codebase, **`CONTEXT.md` serves as the single source of truth and living handoff bridge.**

### Rules for Incoming & Outgoing Agents:
1. **Mandatory Ingestion**: Before modifying any code, reading schemas, or adjusting configuration, every agent **MUST read `CONTEXT.md` in full** to understand active state, mathematical proofs, security invariants, and persona tokens.
2. **Mandatory Append-Only Logging**: Every agent **MUST append an entry to Section 6 of `CONTEXT.md`** before concluding its session. The entry must record:
   - **Timestamp & Agent Persona/Role**.
   - **Specific Changes Made**: Detail any files modified, added, or removed.
   - **Rationale & Architectural Impact**: Why the change was made and any ADR implications.
   - **Test & Verification Results**: Exact pass/fail counts from `npm test`, `comprehensive_e2e_audit.mjs`, and `run.py`.
   - **Handoff Notes for the Next Agent**: Any open items, suggestions, or edge cases to watch.
3. **No Stealth Edits**: Never modify or remove existing entries in the `CONTEXT.md` ledger. It is an append-only historical audit trail.
