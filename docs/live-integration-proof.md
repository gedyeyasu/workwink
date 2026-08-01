# Live integration proof

Verified on 2026-07-31 against the configured Apify account and Elastic Serverless deployment. No sample records were inserted.

## Apify

- Allowed Actor: `apify/web-scraper`
- Successful structured-data run: `pro8KQQYrA91RYFMR`
- Dataset: `K0srDd9jy5gbOy2aC`
- Public source: a current OpenAI role hosted on Ashby
- Actor result: 1 request succeeded, 0 failed, 1 `JobPosting` dataset item
- Cost reported by Apify: `$0.0010265694511019526`
- Recurring schedule: `IctqdM98NGHqgvCiE`
- Schedule: enabled, exclusive, `0 */6 * * *`, UTC
- Scheduled source: Linear's public Ashby board

The first probe against Anthropic's Greenhouse board crawled 56 pages with zero request failures but emitted no `JobPosting` JSON-LD. WorkWink did not invent fallback records; the source was replaced with a board that publishes the required structured contract.

## Elasticsearch

- Deployment type: Elastic Serverless
- Reported version: `9.6.0`
- Backing index: `workwink-jobs-v1`
- Read alias: `workwink-jobs-read`
- Write alias: `workwink-jobs-write`
- Ingestion ledger: `workwink-ingestion-runs`

Importer result for `pro8KQQYrA91RYFMR`:

```json
{
  "collected": 1,
  "accepted": 1,
  "rejected": 0,
  "indexed": 1,
  "failed": 0,
  "status": "complete"
}
```

The production search endpoint returned the real OpenAI Workday Engineer document with an Elasticsearch score, three highlighted evidence fragments, salary and freshness metadata, source provenance, and non-empty work-mode, seniority, title-family, skill, company, and employment-type aggregations. The measured Elasticsearch request took 184 ms.

## Reproduce

```bash
pnpm setup:elastic
pnpm apify:run -- https://jobs.ashbyhq.com/linear
pnpm ingest:run -- <RUN_ID>
pnpm dev
```

The public source may change after this proof was recorded; Actor run and dataset IDs preserve the audit trail in Apify.
