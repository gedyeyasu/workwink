# WorkWink

**Swipe into work worth wanting.**

WorkWink is a real-time job discovery application for the Elastic × Apify hackathon. Apify's official Web Scraper Actor collects public job postings from company ATS boards. WorkWink validates and normalizes that dataset, bulk-indexes it into Elasticsearch, and serves a swipe feed whose search, counts, filters, and provenance all come from the live index.

There is deliberately no runtime demo-data mode. Missing credentials or an unavailable integration produces an explicit error state.

## The winning path

```text
Apify official Web Scraper Actor
  -> JSON-LD JobPosting dataset
  -> schema validation + normalization + deduplication
  -> Elasticsearch versioned job index
  -> lexical/hybrid retrieval + disjunctive aggregations
  -> instant facet filters + swipe feed
```

## Requirements

- Node.js 22+
- pnpm 9+
- An Apify token with access to Apify-maintained Actors
- An Elasticsearch endpoint and API key
- For hybrid retrieval, an explicit Elastic inference endpoint id

Copy `.env.example` to `.env`. At minimum:

```dotenv
APIFY_TOKEN=...
APIFY_ACTOR_ID=apify/web-scraper
ELASTICSEARCH_URL=https://...
ELASTIC_TOKEN=...
ADMIN_TOKEN=at-least-24-characters
CURSOR_SECRET=at-least-32-characters
```

`ELASTIC_TOKEN` is accepted as an alias for `ELASTICSEARCH_API_KEY`.

## Run the real integration

```bash
pnpm install
pnpm setup:elastic
pnpm apify:run
pnpm ingest:run -- <APIFY_RUN_ID>
pnpm dev
```

Then open `http://localhost:4173`.

The Apify command prints the run and dataset ids, never the token. The ingest command fetches the finished dataset through the official client, rejects malformed records, and reports Elasticsearch bulk failures instead of masking them.

## Six-hour collection

Set `APIFY_WEBHOOK_URL` to the deployed WorkWink endpoint (for example, `https://your-app.example/api/webhooks/apify`), set a 24+ character `APIFY_WEBHOOK_SECRET`, and run:

```bash
pnpm apify:schedule
```

The schedule uses `0 */6 * * *` in UTC and only the official `apify/web-scraper` Actor. Provisioning also registers an `ACTOR.RUN.SUCCEEDED` webhook when its URL and secret are set. The callback authenticates the request, and the importer independently verifies the referenced run through Apify before ingestion.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm smoke:live
```

`smoke:live` is credentialed and traces a real Apify result into an Elasticsearch query and facet bucket. Unit tests may use local values; runtime code never imports them.

## Index design

The read and write aliases point at a versioned backing index. Exact filters use keyword/numeric/date fields, descriptions use analyzed text, and optional semantic retrieval uses an explicit `semantic_text` inference id. Mapping changes create a new version and swap aliases only after verification.

Facet behavior is disjunctive: values inside one facet are ORed; different facets are ANDed; the facet currently being counted excludes only its own selection. This keeps counts useful while users filter.

See [`docs/engineering-plan.md`](docs/engineering-plan.md) for the reviewed architecture and failure model.

See [`docs/live-integration-proof.md`](docs/live-integration-proof.md) for the credentialed Apify-to-Elastic verification record.
