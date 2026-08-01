# WorkWink Engineering Plan

Status: APPROVED
Review target: `/Users/gedeoneyasu/Projects/elastic-apify-hack-night-2026`
Source design: `docs/product-design.md`

## Outcome

Replace the existing Career Crush prototype with a production-shaped WorkWink data and search spine. The shipped slice must run a real Apify Actor, import its real dataset idempotently, index normalized jobs in Elasticsearch, execute index-backed hybrid search, return live aggregations, and power responsive UI filters from those aggregations. There is no demo-data fallback in runtime code.

## Step 0: Scope Challenge

The current repository already contains small Apify and Elastic HTTP wrappers, a first mapping, a ranking sketch, and a swipe-card UI. Their ideas can be reused, but their implementations cannot: the Apify wrapper uses a deprecated path and URL token, Elasticsearch has no versioned mapping or bulk importer, and the server/UI are coupled to fake records.

The original startup plan crosses more than eight files and would normally trigger a scope stop. The user explicitly reduced scope to the integration spine. Accepted scope reduction:

- Build real Apify execution, scheduling support, dataset pagination, webhook verification, normalization, deduplication, and ingestion reporting.
- Build real Elasticsearch index lifecycle, bulk writes, hybrid/index search, aggregations, stable pagination, and filter semantics.
- Build the production UI path against those APIs, including loading, empty, partial-failure, and stale-data states.
- Keep identity to one signed demo session and store swipe preferences without building email, organizations, billing, or full account lifecycle.
- Keep resume file parsing and application generation behind typed interfaces until the search spine passes against real services.

## Architecture Review

Recommendation: a modular monolith with one web process and one worker/CLI process from the same TypeScript codebase. This is the smallest honest production boundary: long imports cannot block HTTP requests, but microservices are unnecessary.

```text
                         every 6 hours
                    +---------------------+
                    |   Apify Schedule    |
                    +----------+----------+
                               |
                               v
                    +---------------------+
                    | Job Actor / Task    |
                    | real web collection |
                    +----------+----------+
                               | SUCCEEDED webhook (runId)
                               v
+-------------+      +---------------------+      +----------------------+
| WorkWink UI | ---> | Web API             | ---> | PostgreSQL           |
| swipe+filter| <--- | search, facets,      |      | runs, swipes, prefs  |
+-------------+      | signed demo session |      +----------+-----------+
                     +----------+----------+                 |
                                | atomic enqueue             | pg-boss
                                v                            v
                     +---------------------------------------+
                     | Import Worker                         |
                     | verify run -> paginate dataset ->     |
                     | validate -> normalize -> dedupe       |
                     +-------------------+-------------------+
                                         | NDJSON bulk
                                         v
                     +---------------------------------------+
                     | Elasticsearch                         |
                     | versioned index + read/write aliases  |
                     | lexical + semantic + filters + aggs   |
                     +---------------------------------------+
```

### System boundaries

- `apps/web`: Next.js 16 UI and route handlers. It owns HTTP validation, signed demo-session enforcement, search orchestration, and UI rendering.
- `apps/worker`: long-running pg-boss consumers plus one-shot operational commands for setup, manual import, reindex, and schedule provisioning.
- `packages/contracts`: Zod schemas shared at every boundary. Unknown Actor fields are preserved only in a quarantined raw snapshot, never spread into search documents.
- `packages/apify`: official `apify-client`, bearer authentication, Actor/task execution, run verification, paginated dataset iteration, schedule provisioning, and source adapters.
- `packages/search`: official Elastic client, index templates, alias management, bulk writes, search/facet query builders, cursor encoding, and typed response mapping.
- `packages/db`: PostgreSQL/Drizzle schema for ingestion runs, normalized source identity, demo profile, swipe events, and preference versions. Jobs are canonically recoverable here; Elastic remains a read projection.
- `packages/domain`: source-independent job normalization, fingerprints, lifecycle rules, scoring policy, and learned-affinity updates.

### Blocking live-integration gate (T0)

Primary source: Apify's maintained `apify/web-scraper` Actor, not a community Actor and not a custom Actor. WorkWink generates a bounded browser-crawl input for allowlisted public Greenhouse, Lever, and Ashby boards. Its page function follows provider-specific detail links, extracts Schema.org `JobPosting` JSON-LD, and emits the raw posting with canonical URLs, provider, Actor identity, crawl timestamps, and discovery provenance. The runtime rejects every other Actor ID.

Before application work, run the official Actor with real Apify credentials against at least one public company board, capture its real dataset, normalize at least one dataset page, and index/search it in the user's real Elastic deployment. If the official Actor or source schema is unusable, the live-data requirement is blocked and the UI must not proceed against fixtures.

The Elastic probe records deployment type and version/capabilities. The target query uses an explicit `workwink-elser` inference endpoint, a `semantic_text` field, lexical `multi_match`, and RRF on deployments that support them. Index provisioning performs a small mapping/index/query/delete canary first. `SEARCH_MODE=hybrid` fails startup if the canary fails; `SEARCH_MODE=lexical` is an explicit real-search fallback for development or outage response and never emits semantic component scores.

### Import state machine and consistency invariant

```text
RECEIVED -> FETCHING -> NORMALIZING -> PROJECTING -> COMPLETE
    |           |             |             |
    +-----------+-------------+-------------+--> FAILED
                              +-----------------> PARTIAL
```

The database persists run id, dataset id, source, adapter version, page offset, counts, error samples, started/finished timestamps, and state. Each canonical upsert emits a projection outbox row in the same transaction. The worker bulk-indexes outbox rows and marks each projected or dead-lettered under an explicit reason. A run becomes `COMPLETE` only when all accepted canonical versions are projected and the index refresh succeeds. `PARTIAL` may publish valid new jobs but never advances absence counters, global freshness, or source-complete timestamps. A reconciler requeues unprojected outbox rows and stuck nonterminal runs after leases expire.

### Job index contract

`workwink-jobs-vNNNNNN` sits behind `workwink-jobs-read` and `workwink-jobs-write` aliases. Mapping changes always create a new version and reindex before an atomic alias swap.

Core fields:

- Identity/provenance: `job_id`, `source`, `source_job_id`, `source_run_id`, `source_url`, `apply_url`, `collected_at`, `verified_at`, `content_hash`, `schema_version`.
- Search text: `title`, `company_name`, `description`, `requirements`, `skills`, `search_text`, and `semantic_text` copied from `search_text` with an explicit inference id.
- Exact filters: normalized title family, seniority, company, work mode, employment type, industries, skills, currency, visa sponsorship, and lifecycle state as keyword fields.
- Numeric/geo filters: salary min/max/period, posted/collected/verified dates, and optional `geo_point`.
- Explanation inputs: required/preferred skills, normalized constraints, source evidence snippets, and score-policy version.

Dynamic mappings are disabled. Strings never silently become analyzed fields. Currency and pay period are never compared until compensation is normalized to an annual range with the original values retained.

### Search and aggregation contract

`POST /api/search/jobs` accepts a versioned schema with query text, hard filters, sort, and opaque cursor. It returns `items`, `facets`, `page`, `queryVersion`, `indexVersion`, and `dataFreshness`.

- Filter clauses execute in bool filter context for cacheability.
- Lexical retrieval searches title, company, skills, requirements, and description with deliberate boosts.
- Semantic retrieval matches the `semantic_text` field. Reciprocal-rank fusion combines lexical and semantic candidates when inference is healthy; lexical-only is explicit degradation, never a fake semantic score.
- Aggregations return work mode, seniority, title family, company, skills, industry, employment type, salary ranges, posted-age ranges, and geo distance where coordinates exist.
- Disjunctive facets use filter aggregations so selecting `Remote` does not erase useful counts for `Hybrid` and `On-site`. The response reports approximate/truncated high-cardinality facets.
- Stable pagination uses point-in-time plus `search_after`, never deep `from/size` pagination.
- Every response filters `_source` to card fields. Full descriptions load only on the details route.

Facet semantics are fixed: OR within one facet, AND across different facets; selecting `Remote` still computes work-mode counts with only the work-mode filter self-excluded, while query text and all other filters remain applied. Salary filters match ranges that overlap the requested normalized annual range; missing/unknown salary is included only when the request explicitly permits it. Multi-select counts and behavior are contract-tested.

The cursor is HMAC-signed and binds the PIT id, query/filter/sort hash, index version, page size, expiry, and last sort tuple. Results sort by relevance, then `verified_at`, then `job_id` as the deterministic tie-breaker. A changed filter, sort, page size, index version, expired PIT, or tampered signature invalidates the cursor with a typed restart response.

### Fast filter UI

Filter state lives in the URL, is validated client-side and server-side, and submits after a 150 ms debounce. Each new request aborts the previous one. The interface keeps the last successful cards during refresh, shows per-filter counts from Elastic, announces result changes accessibly, and distinguishes zero results from integration failure. Mobile chips expose the same state as the desktop facet panel.

### Security boundary

Apify and Elastic secrets remain server-only. Apify uses bearer headers, never query-string tokens. Webhooks contain a high-entropy route secret and the server independently fetches the referenced run from Apify before atomically enqueueing it. Search input is schema-validated with bounded lengths, aggregation allowlists, maximum page size, and no raw Query DSL escape hatch. Scraped HTML is sanitized before rendering.

## Code Quality Review

- Scrap `src/demo-data.js` and all runtime branches that return fixtures. Tests may use local fixtures only inside test files.
- Replace hand-written `fetch` wrappers with official clients to inherit supported pagination, retries, error objects, and authentication behavior.
- Keep one canonical `Job` contract and source-specific adapters. Do not leak LinkedIn/Indeed/Actor field names into the domain or UI.
- Return typed problem details with stable error codes. Logs include correlation id, Actor run id, dataset id, index alias/version, and redacted error cause.
- Validate configuration at process startup. The app fails closed when Apify or Elastic credentials are missing in integration mode.
- Every idempotency decision is backed by a unique database constraint, not a process-local set.

## Test Review

```text
                           WORKWINK TEST MAP

                    +---------------------------+
                    | Pure unit tests           |
                    | normalize, fingerprint,   |
                    | filters, cursor, scoring  |
                    +-------------+-------------+
                                  |
              +-------------------+-------------------+
              v                                       v
  +---------------------------+         +-----------------------------+
  | Contract tests            |         | Integration tests           |
  | captured Actor schemas,   |         | PostgreSQL + Elasticsearch  |
  | rejected malformed items  |         | aliases, bulk, aggs, PIT    |
  +-------------+-------------+         +---------------+-------------+
                |                                         |
                +----------------------+------------------+
                                       v
                         +-----------------------------+
                         | End-to-end browser tests    |
                         | real local services,        |
                         | search/filter/swipe states  |
                         +---------------+-------------+
                                         |
                                         v
                         +-----------------------------+
                         | Credentialed smoke tests    |
                         | real Apify run + real       |
                         | Elastic index/query         |
                         +-----------------------------+
```

Required regression coverage:

- Dataset pagination imports every item once and survives replay, partial bulk failure, malformed records, and worker restart.
- Fingerprints merge true duplicates but keep similar roles with different locations or requisition ids separate.
- Missing salary never satisfies a minimum salary filter; hourly and annual compensation normalize correctly; unknown currency stays unfiltered.
- Facet counts remain useful when a facet is selected and match a direct Elastic query.
- Search handles inference outage, empty eligible set, expired PIT, invalid cursor, closed/stale jobs, and high-cardinality facets.
- UI aborts stale responses, persists URL filters, supports keyboard swipe controls, and renders no scraped HTML unsafely.

Verification commands: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:e2e`, and `pnpm smoke:live` when credentials are present.

## Performance Review

- Ingest with bounded dataset pages and NDJSON bulk batches sized by bytes, not only item count. Retry only failed bulk items with exponential backoff and jitter.
- Refresh the index once after a completed import, not per document. Use an ingest run status document for freshness rather than forcing refresh on read.
- Keep exact filters on keyword/numeric/date/geo fields with doc values. Never aggregate analyzed descriptions.
- Cap facet sizes, expose `sum_other_doc_count`, and use composite aggregation only for administrative exports.
- Reuse Elastic connections, set request deadlines, and bound concurrent bulk requests. Backpressure pauses dataset pagination.
- Target p95 search under 800 ms and filter-only changes under 500 ms at 10 concurrent users with 250,000 active jobs.
- `pnpm perf:seed` creates a deterministic test-only 250,000-document corpus in a disposable index; `pnpm perf:search` warms it, then reports cold and warm p50/p95/p99, error rate, process heap, and bulk throughput and fails when budgets are missed.

## Deployment Topology

Railway is the first deployment target: one web service, one persistent worker service, and one managed PostgreSQL database from the same repository. Elastic remains Elastic Cloud and scraping/scheduling remains Apify. Railway secrets hold server-only credentials; migrations run as an explicit release command before web/worker rollout. The web service exposes the public HTTPS webhook URL, while the worker has no public ingress. A pre-demo gate provisions the Apify schedule/webhook against the deployed URL and runs one complete deployed trace.

## Failure Modes

| Failure | User-visible behavior | Recovery |
|---|---|---|
| Apify run fails | Existing feed remains with a visible freshness warning | Apify retry policy and failed-run status; no destructive aging from incomplete runs |
| Duplicate webhook | No duplicate import | Unique run id plus atomic run/queue transaction |
| Partial dataset or schema drift | Valid records import; run is marked partial with quarantined counts | Adapter contract alert, dead-letter samples, replay after adapter update |
| Elastic bulk partial failure | Failed ids are retried; alias remains on prior complete index during reindex | Retry budget, dead letter, resumable reindex |
| Elastic inference unavailable | Lexical-only results labeled degraded | Circuit breaker and health probe; semantic resumes automatically |
| PIT/cursor expires | UI restarts from the first page and reports feed refresh | Issue new PIT; never return a 500 for expected expiry |
| Worker crashes | HTTP stays available; import remains queued/visible | pg-boss lease/retry and idempotent stages |
| Stale Actor source | Jobs age to stale but do not disappear during an incomplete run | Only complete runs advance absence counters |

## What Already Exists

- The repository has a polished swipe-card interaction worth preserving visually.
- `src/signals.js` and `src/matching.js` contain early field and scoring ideas, but their fake precomputed values must not survive.
- `src/apify.js` and `src/elastic.js` prove intended boundaries, but both are too small and unsafe for production use.
- The current Node test runner proves pure functions can be tested quickly; the new project keeps fast unit tests and adds service-backed suites.

## NOT in Scope

- Public signup, social login, password recovery, organizations, billing, or enterprise SSO.
- Automated application submission or browser control.
- Multiple job families or unlimited Apify source adapters before one source is reliable.
- A learned ML ranking model. V1 uses a transparent deterministic score plus bounded swipe affinities.
- Mobile native clients, employer workflows, or recruiter tooling.
- Kubernetes or independently deployed microservices.

## Worktree Parallelization Strategy

The implementation should remain sequential in this session because the existing project is small and the new modules share foundational contracts. Once contracts land, independent test and UI lanes can run in parallel without touching the same directories.

| Step | Modules touched | Depends on |
|---|---|---|
| Foundation and contracts | workspace config, contracts/, domain/ | — |
| Apify integration | apify/, db/, worker/ | foundation |
| Elastic projection and search | search/, domain/, worker/ | foundation |
| Search API and UI | web/, contracts/ | Elastic search |
| Integration and browser tests | test/, web/ | all runtime lanes |

Lane A: foundation → Apify ingestion → operational commands.
Lane B: foundation → Elastic index/search.
Lane C: wait for A+B → API/UI → end-to-end verification.

Conflict flag: lanes A and B both consume domain contracts. Freeze those contracts before parallel work or run the lanes sequentially.

## Implementation Tasks

- [ ] **T0 (P0, human: ~2h / CC: ~20min)** — live integration — Prove the selected Apify Actor and Elastic feature set with real credentials before UI work.
  - Surfaced by: Outside Engineering Review — no source, schema, terms, deployment capability, or credentialed end-to-end spike was selected.
  - Verify: persist one trace artifact containing `runId → datasetId → canonical jobId → Elastic document id → API result id → facet bucket → rendered card provenance` with secrets redacted.

- [ ] **T1 (P1, human: ~6h / CC: ~45min)** — foundation — Replace the prototype with a typed workspace and strict runtime configuration.
  - Surfaced by: Code Quality Review — runtime paths are coupled to fake records and unvalidated environment values.
  - Verify: `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **T2 (P1, human: ~8h / CC: ~60min)** — Apify — Implement official-client Actor/task execution, schedule provisioning, run verification, dataset pagination, adapters, and idempotent import state.
  - Surfaced by: Architecture Review — the current wrapper uses deprecated endpoints, URL tokens, and no lifecycle handling.
  - Verify: replay a credentialed Actor run twice and compare canonical/import counts.
- [ ] **T3 (P1, human: ~8h / CC: ~60min)** — Elasticsearch — Implement versioned mappings/aliases, bulk indexing, hybrid retrieval, aggregations, PIT cursors, and lexical degradation.
  - Surfaced by: Architecture and Performance Reviews — current search has no production index lifecycle or aggregation contract.
  - Verify: integration suite plus direct count/facet comparison against Elasticsearch.
- [ ] **T4 (P1, human: ~8h / CC: ~60min)** — web — Build the real search API and responsive facet/swipe UI with URL state, cancellation, provenance, and failure states.
  - Surfaced by: Scope Challenge — the hackathon win depends on visible Elastic-powered interaction, not backend-only integration.
  - Verify: Playwright critical path and live browser smoke test.
- [ ] **T5 (P1, human: ~6h / CC: ~45min)** — operations — Add Docker services, migrations, CI, health/readiness, structured logs, run status, and live smoke scripts.
  - Surfaced by: Failure Modes — real integrations need observable recovery paths and repeatable deployment.
  - Verify: clean clone setup, migration, ingestion, and smoke run.
- [ ] **T6 (P1, human: ~3h / CC: ~25min)** — release — Deploy web/worker/PostgreSQL to Railway and prove the scheduled Actor-to-UI path on the hosted environment.
  - Surfaced by: Outside Engineering Review — a local stack cannot receive Apify webhooks and does not satisfy the demo completeness gate.
  - Verify: `pnpm smoke:deployed` asserts live provenance and the UI screenshot records the same source URL.

## Review Completion Summary

- Step 0: Scope Challenge — scope reduced per the user's Apify/Elastic priority.
- Architecture Review: 4 issues found and incorporated: fake-data coupling, unsafe Apify auth/lifecycle, missing Elastic index lifecycle, and blocking imports.
- Code Quality Review: 5 issues found and incorporated: duplicated contracts, custom clients, unvalidated config, process-local idempotency, and weak error taxonomy.
- Test Review: diagram produced; 6 regression groups required.
- Performance Review: 6 issues found and incorporated around bulk backpressure, refresh behavior, facet cardinality, pagination, connection reuse, and latency budgets.
- NOT in scope: written.
- What already exists: written.
- TODOS.md updates: represented as implementation tasks; no separate TODO file exists.
- Failure modes: 8 critical cases specified.
- Outside voice: ran; 7 gaps found and incorporated.
- Parallelization: 3 lanes, 2 potentially parallel after contract freeze and 1 sequential integration lane.
- Lake Score: 5/5 recommendations use complete real-integration paths.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | Office-hours product diagnostic completed instead |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | Not run |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 22 issues incorporated, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | Deferred until real data renders |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not required before integration build |

**CROSS-MODEL:** Independent review agreed on the fake-free architecture and required a blocking source/capability spike, persisted import state machine, signed cursor contract, deployed trace, and executable load profile; all are now included.

**VERDICT:** ENG CLEARED — ready to implement the Apify and Elasticsearch integration spine, beginning with T0.

NO UNRESOLVED DECISIONS
