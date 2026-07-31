# Career Crush

> A real-time job discovery agent that learns what you would actually accept.

Career Crush turns noisy, fast-changing job listings into an evidence-backed swipe feed:

> **"Is this a role I would actually say yes to?"**

It fetches fresh listings from Apify Actors, records them in Elasticsearch as attributable job documents, and ranks them against a user's resume, preferences, and swipe behavior. Every match score is explainable.

## Why this fits the Elastic × Apify challenge

- **Apify** provides live, on-demand job data—the feed is not a stale job-board snapshot.
- **Elasticsearch** performs hybrid retrieval and stores jobs, profiles, and swipe history so ranking adapts after every decision.
- **The outcome is actionable:** each card shows a match score, supporting evidence, risks, and a tailored application draft.

## Hack-night demo

1. Create an account and upload a resume.
2. Set preferences: "platform engineering, remote or Austin, $140k minimum."
3. Swipe through fresh jobs.
4. Open a high-match role to see the evidence-backed score.
5. Generate a tailored application package for user approval.

## Initial architecture

```text
Apify Actors → normalize + deduplicate → Elasticsearch job memory → hybrid retrieval → adaptive swipe feed → application draft
```

The first slice keeps source adapters small and testable. It normalizes raw records into provenance-preserving job documents, prepares an Elasticsearch mapping suited to hybrid retrieval, and includes a demo web app with realistic job data.

## Local development

Requires Node.js 20+.

```bash
npm test

npm run dev
```

No credentials are needed for the initial tests. Add `APIFY_TOKEN` and `ELASTICSEARCH_URL` to `.env` only when connecting the live ingestion path.

The live seams are in `src/apify.js` and `src/elastic.js`: run an Apify Actor, fetch its dataset, normalize the records, and index them into Elasticsearch. The web app stays in demo mode until those credentials are intentionally wired into the server.

## Next build steps

- Connect selected Apify Actors and ingest their datasets.
- Create the Elasticsearch index and enable semantic/hybrid retrieval.
- Connect the profile and swipe events to a hosted store.
- Add a browser handoff for assisted application submission.
- Deploy a shareable demo before submission.
