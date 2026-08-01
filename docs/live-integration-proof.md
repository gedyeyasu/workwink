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
- Full board run: `jK87hMMOIi8cPaXf6`
- Full board dataset: `I1C3r3yPEGieIwgyI`
- Full board result: 46 requests succeeded, 0 failed; 46 records accepted and indexed, 0 rejected or failed
- Sponsor run: `oQOKuuV18iF7mq0HV`
- Sponsor dataset: `ms1hr1R6oVhex0nj9`
- Sponsor sources: Apify's public Ashby careers board and Elastic's public Greenhouse board API
- Sponsor crawl result: 29 requests succeeded, 0 failed; 260 Actor dataset records
- Sponsor import result: 261 collected, 261 accepted, 261 indexed, 0 rejected, 0 bulk failures
- The six-hour schedule now targets the Apify and Elastic sponsor sources
- Saved official-Actor Task: `TvuuqUw3sThzhzUqr` (`workwink-sponsor-job-scraper`), runnable directly from Apify Console

### California software compensation run

- Official Actor run: `09XJwPqne2cc1k6ZF`
- Dataset: `DVn3F5MwrHS2QQrSo`
- Sources: Anthropic, Scale AI, and Reddit public Greenhouse APIs
- Actor result: 3 requests succeeded, 0 failed; 803 dataset records
- Apify-reported cost: `$0.004151372085736856`
- Import result: 803 collected, 803 accepted, 803 indexed, 0 rejected, 0 bulk failures
- Live job-document count after the import: 1,075
- Elasticsearch salary query: 143 software-engineering jobs with a non-null disclosed annual range
- Company facet counts: Anthropic 82, Scale AI 33, Reddit 27, OpenAI 1
- Measured Elasticsearch execution: 9 ms overall; company verification queries completed in 60–69 ms

Greenhouse pay-transparency fragments arrived as double-encoded HTML. The normalizer now decodes at most two entity layers, strips all markup, and extracts only explicit USD ranges with salary or annual context. It preserves the exact matched disclosure in `salary.sourceText`; single dollar values and unrelated budget ranges remain unknown. Replaying the same run with `--force` was an idempotent upsert and did not spend additional Apify credits.

The first probe against Anthropic's Greenhouse board crawled 56 pages with zero request failures but emitted no `JobPosting` JSON-LD. WorkWink did not invent fallback records; the source was replaced with a board that publishes the required structured contract.

## Elasticsearch

- Deployment type: Elastic Serverless
- Reported version: `9.6.0`
- Backing index: `workwink-jobs-v1`
- Read alias: `workwink-jobs-read`
- Write alias: `workwink-jobs-write`
- Ingestion ledger: `workwink-ingestion-runs`
- AI profile cache: `workwink-ai-job-profiles-v1`
- Native NVIDIA inference endpoint: `workwink-nemotron`
- Live document count after the sponsor import: 272 (stable IDs retain prior verified runs)
- Private application queue: `workwink-applications-v1`; live idempotency and signed-session isolation verified against Elastic Serverless

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

The production search endpoint returned the real OpenAI Workday Engineer document with an Elasticsearch score, three highlighted evidence fragments, salary and freshness metadata, source provenance, and non-empty work-mode, seniority, title-family, skill, company, and employment-type aggregations. The measured query request took 184 ms. After the full Linear import, an unfiltered 365-day query returned 20 current roles, a signed next-page cursor, multi-value facet buckets, and 11 ms Elasticsearch execution time.

## Reproduce

```bash
pnpm setup:elastic
pnpm apify:run -- https://jobs.ashbyhq.com/apify 'https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=true'
pnpm ingest:run -- <RUN_ID>
pnpm dev
```

The public source may change after this proof was recorded; Actor run and dataset IDs preserve the audit trail in Apify.
