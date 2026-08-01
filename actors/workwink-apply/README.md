# WorkWink Apply Actor

Private Apify Actor for preparing one user-approved job application in a real ATS browser session. It supports Greenhouse, Ashby, and Lever through explicit provider adapters.

This Actor is deliberately not a universal auto-apply bot. It fills only fields supplied by WorkWink, stops when it encounters uncertainty, and records an auditable machine-readable result.

## Safety model

- `PREPARE` is the default. It fills known fields and **never clicks final submit**.
- `SUBMIT` requires a secret per-application `approvalToken` in Actor input, plus a still-valid `single_application` authorization returned by the WorkWink API.
- A short-lived `dispatchToken` exchanges an opaque application ID for one server-side lease. Applicant data and resume bytes are not embedded in Actor input.
- Apify encrypts both secret input fields using `isSecret: true`.
- The WorkWink API host can be pinned with `WORKWINK_ALLOWED_API_HOSTS`.
- Apply URLs must be HTTPS and their host must be signed into the lease.
- Resume bytes must come from the same WorkWink API origin, be at most 5 MiB, and match the lease SHA-256 digest.
- CAPTCHA, bot challenges, missing required fields, unknown form layouts, and unconfirmed submissions return `NEEDS_USER`.
- Browser retries are disabled. The Actor makes at most one final-submit click.
- Screenshots are opt-in because application forms contain private information.

No live application is submitted by the tests or by a `PREPARE` demo.

## Run contract

Actor input contains only orchestration references:

```json
{
  "applicationId": "app_01ABCDEF",
  "workwinkApiBaseUrl": "https://workwink.example.com",
  "mode": "PREPARE",
  "dispatchToken": "<single-use secret with at least 32 characters>",
  "captureAuditScreenshot": false,
  "navigationTimeoutSecs": 45
}
```

For `SUBMIT`, add the secret `approvalToken` minted only after the user approves the exact application package. Possessing a dispatch token alone is never enough to submit.

The Actor calls:

```text
POST /api/internal/applications/:applicationId/actor-lease
GET  <same-origin signed resume URL returned by the lease>
POST /api/internal/applications/:applicationId/actor-result
```

**Integration status:** these three private WorkWink orchestration endpoints are the required production boundary and are not implemented by this Actor. Until the main WorkWink API adds them, a Console run will fail closed while acquiring its lease; it will not fall back to embedded profile data or fake results.

The lease endpoint validates the dispatch token and, in submit mode, the approval token. Its response binds the application ID, ATS provider, apply URL, allowed host, applicant profile, hash-verified resume, answers, expiry, idempotency key, and approval scope. A prior submission receipt prevents duplicate work.

The result is written to the Apify default dataset and reported to WorkWink. Statuses are:

```text
PREPARED | SUBMITTED | NEEDS_USER | FAILED
```

The `reasonCode` distinguishes a ready review, confirmed submission, prior submission, CAPTCHA, incomplete required fields, unsupported form, ambiguous submission, rejected authorization, expired lease, and operational failure.

## Demo in Apify Console

1. Deploy this directory as a **private Actor**.
2. Configure `WORKWINK_ALLOWED_API_HOSTS` with the deployed WorkWink API hostname.
3. In the Actor Input tab, enter a queued WorkWink `applicationId`, API URL, and short-lived dispatch token.
4. Leave mode as `PREPARE`.
5. Click **Start** and show the live browser logs.
6. Open the Output tab to show `PREPARED`, filled field names, missing required fields, ATS provider, and final URL.

Do not use `SUBMIT` during a judge demo. The prepared application can be reviewed in WorkWink without creating an accidental application.

## Develop and deploy

```bash
npm ci
npm run typecheck
npm test
npm run build
apify login
apify push
```

The Docker image and Playwright package are pinned to `22-1.61.1` for reproducibility. The `.actor` directory defines the Console input form, output link, and dataset table.

## Adapter maintenance

ATS markup changes over time. Each provider adapter owns its form roots, safe initial Apply control, field selectors, final-submit control, and confirmation phrases. A selector update should be tested against a non-production test posting in `PREPARE` mode before deployment.

Custom questions are filled only when the server-supplied question matches an accessible label exactly. Radio options also require an exact option label. Questions that cannot be answered with confidence remain visible as required fields and stop the run for user input.
