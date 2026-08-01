import {
  ApifyClient,
  ScheduleActions,
  type ActorRun,
  type Schedule,
  type ScheduleCreateOrUpdateData,
  type Webhook
} from "apify-client";
import {
  OFFICIAL_WEB_SCRAPER_ACTOR_ID,
  buildWebScraperInput,
  type WebScraperInput,
  type WebScraperInputOptions
} from "../apify/web-scraper-input.js";

export interface ApifyDatasetItem extends Record<string, unknown> {
  schemaVersion: 1;
  sourceActor: typeof OFFICIAL_WEB_SCRAPER_ACTOR_ID;
  provider: "greenhouse" | "lever" | "ashby";
  sourceUrl: string;
  scrapedAt: string;
  pageUrl: string;
  requestedUrl: string;
  canonicalUrl: string;
  crawledAt: string;
  jobPosting: Record<string, unknown>;
  provenance: Record<string, unknown>;
}

export interface RunApifyWebScraperOptions extends WebScraperInputOptions {
  token: string;
  startUrls: readonly string[];
  actorId?: string;
  waitSecs?: number;
  timeoutSecs?: number;
  memoryMbytes?: number;
  datasetPageSize?: number;
  client?: ApifyClient;
}

export interface ApifyWebScraperResult {
  runId: string;
  datasetId: string;
  status: ActorRun["status"];
  startedAt: Date;
  finishedAt: Date;
  usageTotalUsd?: number;
  items: ApifyDatasetItem[];
}

export interface UpsertSixHourScheduleOptions extends WebScraperInputOptions {
  token: string;
  startUrls: readonly string[];
  scheduleId?: string;
  scheduleName?: string;
  client?: ApifyClient;
}

export interface UpsertScheduleResult {
  schedule: Schedule;
  created: boolean;
}

export interface UpsertSuccessWebhookOptions {
  token: string;
  requestUrl: string;
  secret: string;
  client?: ApifyClient;
}

export interface UpsertSuccessWebhookResult {
  webhook: Webhook;
  created: boolean;
}

export const SIX_HOUR_CRON = "0 */6 * * *" as const;
export const DEFAULT_SCHEDULE_NAME = "workwink-six-hour-job-scrape" as const;
export const WEBHOOK_DESCRIPTION = "WorkWink: import successful official Web Scraper runs" as const;

export function createApifyClient(token: string): ApifyClient {
  if (!token.trim()) throw new Error("APIFY_TOKEN is required for the official Apify Actor.");
  return new ApifyClient({ token });
}

export function assertOfficialWebScraperActor(actorId: string): void {
  if (actorId !== OFFICIAL_WEB_SCRAPER_ACTOR_ID) {
    throw new Error(
      `Only the Apify-maintained ${OFFICIAL_WEB_SCRAPER_ACTOR_ID} Actor is allowed; received ${actorId}.`
    );
  }
}

export async function runApifyWebScraper(
  options: RunApifyWebScraperOptions
): Promise<ApifyWebScraperResult> {
  const actorId = options.actorId ?? OFFICIAL_WEB_SCRAPER_ACTOR_ID;
  assertOfficialWebScraperActor(actorId);
  const client = options.client ?? createApifyClient(options.token);
  const input = buildWebScraperInput(options.startUrls, options);

  const run = await client.actor(actorId).call(input, {
    waitSecs: boundedPositiveInteger(options.waitSecs, 1_200, 3_600, "waitSecs"),
    timeout: boundedPositiveInteger(options.timeoutSecs, 900, 3_600, "timeoutSecs"),
    memory: boundedPositiveInteger(options.memoryMbytes, 2_048, 32_768, "memoryMbytes"),
    log: "default"
  });

  if (run.status !== "SUCCEEDED") {
    throw new Error(
      `Official Apify Web Scraper run ${run.id} did not succeed (status: ${run.status}).`
    );
  }
  if (!run.defaultDatasetId) {
    throw new Error(`Official Apify Web Scraper run ${run.id} returned no dataset ID.`);
  }

  const items = await listAllDatasetItems(
    client,
    run.defaultDatasetId,
    options.datasetPageSize
  );

  return {
    runId: run.id,
    datasetId: run.defaultDatasetId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    ...(run.usageTotalUsd === undefined ? {} : { usageTotalUsd: run.usageTotalUsd }),
    items
  };
}

/** Read a dataset in bounded API pages instead of assuming one response contains every job. */
export async function listAllDatasetItems(
  client: ApifyClient,
  datasetId: string,
  pageSize = 1_000
): Promise<ApifyDatasetItem[]> {
  if (!datasetId.trim()) throw new Error("An Apify dataset ID is required.");
  const limit = boundedPositiveInteger(pageSize, 1_000, 10_000, "datasetPageSize");
  const dataset = client.dataset<ApifyDatasetItem>(datasetId);
  const allItems: ApifyDatasetItem[] = [];
  let offset = 0;

  for (;;) {
    const page = await dataset.listItems({
      offset,
      limit,
      clean: true,
      skipEmpty: true,
      skipHidden: true
    });
    allItems.push(...page.items);
    offset += page.items.length;

    if (page.items.length === 0 || offset >= page.total) break;
  }

  return allItems;
}

/** Create or update an exclusive UTC schedule that runs the same official Actor every six hours. */
export async function upsertSixHourSchedule(
  options: UpsertSixHourScheduleOptions
): Promise<UpsertScheduleResult> {
  const client = options.client ?? createApifyClient(options.token);
  const input = buildWebScraperInput(options.startUrls, options);
  const officialActor = await client.actor(OFFICIAL_WEB_SCRAPER_ACTOR_ID).get();
  if (!officialActor) {
    throw new Error(`Could not resolve the official ${OFFICIAL_WEB_SCRAPER_ACTOR_ID} Actor.`);
  }

  const name = options.scheduleName?.trim() || DEFAULT_SCHEDULE_NAME;
  const scheduleFields: ScheduleCreateOrUpdateData = {
    name,
    title: "WorkWink job crawl — every six hours",
    description:
      "Crawls configured public Greenhouse, Lever, and Ashby boards with Apify's official Web Scraper Actor.",
    cronExpression: SIX_HOUR_CRON,
    timezone: "UTC" as const,
    isEnabled: true,
    isExclusive: true,
    notifications: { email: false },
    actions: [
      {
        type: ScheduleActions.RunActor,
        actorId: officialActor.id,
        runInput: {
          body: JSON.stringify(input),
          contentType: "application/json; charset=utf-8"
        },
        runOptions: {
          build: officialActor.defaultRunOptions.build,
          timeoutSecs: 900,
          memoryMbytes: 2_048
        }
      }
    ]
  };

  if (options.scheduleId?.trim()) {
    const schedule = await client.schedule(options.scheduleId.trim()).update(scheduleFields);
    return { schedule, created: false };
  }

  const existingPage = await client.schedules().list({ limit: 1_000 });
  const existing = existingPage.items.find((schedule) => schedule.name === name);
  if (existing) {
    const schedule = await client.schedule(existing.id).update(scheduleFields);
    return { schedule, created: false };
  }

  const schedule = await client.schedules().create(scheduleFields);
  return { schedule, created: true };
}

/** Provision a persistent success callback for every run of the approved official Actor. */
export async function upsertSuccessWebhook(
  options: UpsertSuccessWebhookOptions
): Promise<UpsertSuccessWebhookResult> {
  const client = options.client ?? createApifyClient(options.token);
  const requestUrl = new URL(options.requestUrl).href;
  if (!requestUrl.startsWith("https://")) throw new Error("APIFY_WEBHOOK_URL must use HTTPS.");
  if (options.secret.length < 24) throw new Error("APIFY_WEBHOOK_SECRET must contain at least 24 characters.");

  const officialActor = await client.actor(OFFICIAL_WEB_SCRAPER_ACTOR_ID).get();
  if (!officialActor) throw new Error(`Could not resolve the official ${OFFICIAL_WEB_SCRAPER_ACTOR_ID} Actor.`);
  const fields = {
    eventTypes: ["ACTOR.RUN.SUCCEEDED"] as const,
    condition: { actorId: officialActor.id },
    requestUrl,
    description: WEBHOOK_DESCRIPTION,
    doNotRetry: false,
    ignoreSslErrors: false,
    headersTemplate: JSON.stringify({ "x-workwink-webhook-secret": options.secret })
  };

  const page = await client.webhooks().list({ limit: 1_000 });
  const existing = page.items.find((webhook) =>
    webhook.description === WEBHOOK_DESCRIPTION ||
    (webhook.requestUrl === requestUrl && "actorId" in webhook.condition && webhook.condition.actorId === officialActor.id)
  );
  if (existing) {
    return { webhook: await client.webhook(existing.id).update(fields), created: false };
  }
  return { webhook: await client.webhooks().create(fields), created: true };
}

export function getBoardUrlsFromCliOrEnv(
  argv: readonly string[],
  envValue: string | undefined
): string[] {
  const cliUrls = argv.filter((value) => !value.startsWith("--"));
  if (cliUrls.length > 0) return cliUrls;
  return envValue ? [envValue] : [];
}

export function describeScraperInput(input: WebScraperInput): Record<string, unknown> {
  return {
    actorId: OFFICIAL_WEB_SCRAPER_ACTOR_ID,
    startUrls: input.startUrls.map(({ url }) => url),
    maxPages: input.maxPagesPerCrawl,
    maxResults: input.maxResultsPerCrawl,
    maxConcurrency: input.maxConcurrency
  };
}

function boundedPositiveInteger(
  value: number | undefined,
  fallback: number,
  maximum: number,
  name: string
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}.`);
  }
  return result;
}
