# Neighborhood Pulse

> A real-time decision agent for people choosing where to live, work, or open a small business.

Neighborhood Pulse turns noisy, fast-changing public web data into a concise answer to one difficult question:

> **"What changed here, and does it change my decision?"**

It fetches fresh signals from Apify Actors (rental listings, local news, community posts, events, and public notices), records them in Elasticsearch as an attributable memory, and answers with source-linked, time-aware evidence.

## Why this fits the Elastic × Apify challenge

- **Apify** provides live, on-demand data from the web—the agent never has to pretend that last week's snapshot is current.
- **Elasticsearch** is the agent's durable memory and retrieval layer: it keeps dated observations, performs hybrid retrieval over a user's preferences and current signals, and exposes *what changed* rather than merely summarizing a page.
- **The outcome is actionable:** a renter, remote worker, or local entrepreneur can compare neighborhoods using the changes that actually matter to them.

## Hack-night demo

1. Add a decision profile: "remote worker, dog owner, $2,400 budget, wants a quiet neighborhood."
2. Ingest fresh Apify datasets for two neighborhoods.
3. Ask: "What changed in East Austin in the last 48 hours, and should I tour this weekend?"
4. Show a short answer backed by retrieved, timestamped source cards: a rent drop, a construction notice, a relevant event, and a community concern.

## Initial architecture

```text
Apify Actors → normalize + deduplicate → Elasticsearch signal memory → hybrid retrieval → decision brief
```

The first slice in this repository keeps the source adapters small and testable. It normalizes raw records into provenance-preserving signals and prepares an Elasticsearch mapping suited to hybrid retrieval.

## Local development

Requires Node.js 20+.

```bash
npm test
```

No credentials are needed for the initial tests. Add `APIFY_TOKEN` and `ELASTICSEARCH_URL` to `.env` only when connecting the live ingestion path.

## Next build steps

- Connect selected Apify Actors and ingest their datasets.
- Create the Elasticsearch index and enable semantic/hybrid retrieval.
- Add a lightweight UI showing a decision profile, fresh evidence, and an explanation.
- Deploy a shareable demo before submission.
