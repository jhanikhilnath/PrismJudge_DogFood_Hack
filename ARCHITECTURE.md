# DOGFOOD 2026 — System Architecture & Design Rationale

**Tagline:** "Build the platform that will judge you."  
**Core Runtime:** Node.js (v22 LTS) · TypeScript · Fastify v5 · SQLite 3 (WAL Mode) · EJS SSR  

---

## 1. High-Level Architectural Diagram

```mermaid
flowchart TD
    subgraph External ["External Actors & Evaluators"]
        Checker["Acceptance Checker (python3 run.py)"]
        Browser["Modern Web Browser"]
        Curl["curl / API Clients"]
    end

    subgraph Container ["Docker Container (dogfood-portal:8080)"]
        subgraph FastifyPipeline ["Fastify Application Pipeline"]
            CookieParser["@fastify/cookie & Header Parser"]
            AuthHook["Global PreHandler Hook (resolveUserHook)"]
            RBACHook["Role Enforcement & Peer Isolation Hook"]
            
            subgraph Routers ["Modular Route Controllers"]
                ProjectsR["/projects\n(Gallery, Submit, Deadline Guard)"]
                JudgingR["/api/judge/scores\n(Hard Peer Isolation, Scoring)"]
                OrganizerR["/organizer, /api/export.csv\n(Progress, Normalization, CSV)"]
                CommunityR["/vote, /comments\n(Randomized Ballots, Anti-Abuse)"]
                PairwiseR["/judge/pairwise\n(Bradley-Terry MM Solver)"]
                WebhooksR["/certificates\n(HMAC-SHA256 Verifiable Records)"]
            end

            subgraph Engines ["Algorithmic Computation Engines"]
                BayesianNorm["Bayesian Shrinkage Z-Score Engine"]
                BTEstimator["Bradley-Terry Pairwise Solver"]
                AuditTrail["Immutable Audit Event Ledger"]
            end

            subgraph ViewLayer ["Server-Side Rendering (SSR)"]
                EJSEngine["@fastify/view (EJS Templates)"]
                StaticAssets["Vanilla CSS / Brutalist Styles"]
            end
        end

        subgraph Persistence ["Embedded Data Layer"]
            SQLiteDB[("SQLite 3 (WAL Mode)\nForeign Keys ON\nBusy Timeout 5000ms")]
            FixturesData["fixtures.json\n(Seeded on Build & Boot)"]
        end
    end

    Checker -->|HTTP GET/POST| CookieParser
    Browser -->|HTTP Requests| CookieParser
    Curl -->|HTTP Requests| CookieParser

    CookieParser --> AuthHook
    AuthHook --> RBACHook
    RBACHook --> Routers

    Routers --> Engines
    Routers --> ViewLayer
    Routers --> SQLiteDB
    FixturesData -.->|Initial Seed| SQLiteDB
```

---

## 2. The One-Command Offline Rule

The organizing committee emphasizes:
> *"docker compose up must start a fully functional, seeded portal on localhost with zero external dependencies. No cloud accounts, no hosted databases, no external APIs... If it does not come up on a laptop with the network off, we cannot adopt it."*

### Architectural Solutions for Offline Independence:
1. **Embedded SQLite 3 (WAL Mode)**:
   - Uses Node.js 22 native `node:sqlite` (`DatabaseSync`).
   - Zero external database containers required.
   - Eliminates container-to-container network dependencies, DNS lookup delays, and port race conditions.
   - Database is initialized and seeded during Docker image build and verified on boot.
2. **Server-Side Rendered (SSR) HTML**:
   - Built with EJS and vanilla CSS/JS.
   - Zero client-side bundlers (Vite, Webpack, npm run build) required at runtime.
   - Zero external CDN dependencies (all styles, scripts, and fonts are self-contained or use system font stacks).
3. **Multi-Stage Offline Docker Build**:
   - `builder` stage compiles TypeScript to `dist/`.
   - `runner` stage contains pre-installed production dependencies and pre-seeded database.
   - Container boots in **under 1 second** and serves all endpoints with the host network disconnected.

---

## 3. Fastify Request Lifecycle & Role Isolation

```mermaid
sequenceDiagram
    autonumber
    actor Client as Client / run.py
    participant Fastify as Fastify Core
    participant Cookie as Cookie & Header Parser
    participant Hook as resolveUserHook
    participant RBAC as enforceJudgePeerIsolation
    participant Handler as Route Handler
    participant DB as SQLite 3

    Client->>Fastify: GET /api/judge/scores?judge=judge_a
    Fastify->>Cookie: Parse Cookie: session=... or Authorization: Bearer
    Fastify->>Hook: Execute resolveUserHook
    Hook->>DB: Query session & join users table
    DB-->>Hook: Return UserSession { userId: 'jdg_02', role: 'judge' }
    Hook-->>Fastify: Attach req.user

    Fastify->>RBAC: Execute preHandler hook
    Note over RBAC: Check requested judge 'judge_a'<br/>vs authenticated user 'jdg_02'
    alt Snooping Attempt (Judge B -> Judge A)
        RBAC-->>Client: 403 Forbidden ("Peer inspection denied")
    else Legitimate Access (Judge A -> Judge A)
        RBAC->>Handler: Forward request
        Handler->>DB: Fetch judge's own scores
        DB-->>Handler: Return score records
        Handler-->>Client: 200 OK (JSON Scores)
    end
```

---

## 4. API First & OpenAPI 3.1 Architecture (Bonus #4)

* The platform integrates `@fastify/swagger` and `@fastify/swagger-ui`.
* Every route schema is compiled directly into a validated OpenAPI 3.1 specification.
* Interactive documentation is accessible live at `/docs`, with raw JSON exported at `/docs/json`.
* Eliminates documentation drift between code and specification.

---

## 5. Audit Logging Architecture

An append-only audit trail (`audit_logs` table) records high-security lifecycle events:
* `LOGIN` / `LOGOUT`
* `PROJECT_SUBMITTED`
* `SUBMISSION_REJECTED_DEADLINE`
* `SCORE_SUBMITTED`
* `COMMUNITY_VOTE_CAST`
* `PAIRWISE_DECISION_RECORDED`
* `CSV_EXPORT_DOWNLOADED`

Logs capture actor ID, actor role, timestamp, action, resource, JSON payload diffs, and IP address. Accessible to organizers via `/api/organizer/audit`.

---

## 6. Role-Based View Architecture & User-Facing Presentation

To provide a consumer-grade user experience free of developer debris, the presentation layer strictly enforces role-based information visibility across all SSR templates:

### Role-Based Navigation Matrix
| Role | Primary Navigation Tabs | Gated / Hidden Endpoints | Profile Actions |
| :--- | :--- | :--- | :--- |
| **Visitor** (`anonymous`) | Gallery, Submit, Ballot | `/judge/*`, `/organizer/*` (HTTP 403 / Redirect) | Direct Sign In Link |
| **Participant** (`participant`) | Gallery, Submit, Ballot | `/judge/*`, `/organizer/*` (HTTP 403 / Redirect) | User Badge & Sign Out |
| **Judge** (`judge`) | Gallery, Ballot, Judging Queue, Pairwise | `/organizer/*` (HTTP 403), Submit (Hidden) | Judge Badge & Sign Out |
| **Organizer** (`organizer`, `admin`) | Gallery, Console, Judging Queue, Pairwise, Ballot, Submit | None (Full System Oversight) | Admin Badge & Sign Out |

### De-Slopping Principles
1. **Zero Technical Artifacts**: Raw session tokens, API keys, developer debug dumps, and internal database primary keys (`usr_part_...`, `jdg_...`) are strictly excluded from client-facing DOM trees.
2. **Context-Sensitive Provenance**: Rather than displaying raw 64-character SHA-256 hexadecimal digests, submissions and certificates present authenticated issuance metadata, certificate identifiers (`DF26-PRJ_XX-HASH`), and human-verifiable verification badges.
3. **Adaptive Time Formatting**: Deadlines and timestamps are rendered as dual-layer `<time class="local-time">` elements, presenting an immediate UTC baseline on the server while automatically adapting to the user's local browser timezone on the client (e.g., `Sunday, 1 March 2026 at 23:30 GMT+5:30 (6:00 PM UTC)`).

