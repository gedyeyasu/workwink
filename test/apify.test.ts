import type { ApifyClient } from "apify-client";
import { describe, expect, it, vi } from "vitest";
import {
  JOB_BOARD_PAGE_FUNCTION,
  OFFICIAL_WEB_SCRAPER_ACTOR_ID,
  buildWebScraperInput,
  getJobBoardProvider,
  parseJobBoardUrls
} from "../src/apify/web-scraper-input.js";
import {
  APIFY_TASK_CONSOLE_BASE_URL,
  assertOfficialWebScraperActor,
  getBoardUrlsFromCliOrEnv,
  listAllDatasetItems,
  upsertOfficialWebScraperTask
} from "../src/integrations/apify.js";

describe("official Apify Web Scraper input", () => {
  it("builds a bounded crawl for all supported public ATS boards", () => {
    const input = buildWebScraperInput([
      "https://job-boards.greenhouse.io/acme",
      "https://jobs.lever.co/acme",
      "https://jobs.ashbyhq.com/acme"
    ]);

    expect(input.startUrls).toEqual([
      { url: "https://job-boards.greenhouse.io/acme" },
      { url: "https://jobs.lever.co/acme" },
      { url: "https://jobs.ashbyhq.com/acme" }
    ]);
    expect(input.customData.sourceActor).toBe(OFFICIAL_WEB_SCRAPER_ACTOR_ID);
    expect(input).toMatchObject({
      respectRobotsTxtFile: true,
      linkSelector: "",
      maxCrawlingDepth: 1,
      maxPagesPerCrawl: 5_000,
      maxResultsPerCrawl: 5_000,
      proxyConfiguration: { useApifyProxy: true }
    });
  });

  it("ships a syntactically valid page function that enqueues links and extracts JobPosting JSON-LD", () => {
    const pageFunction = new Function(`return (${JOB_BOARD_PAGE_FUNCTION})`)();

    expect(pageFunction).toBeTypeOf("function");
    expect(JOB_BOARD_PAGE_FUNCTION).toContain("context.enqueueRequest");
    expect(JOB_BOARD_PAGE_FUNCTION).toContain("application/ld+json");
    expect(JOB_BOARD_PAGE_FUNCTION).toContain("JobPosting");
    expect(JOB_BOARD_PAGE_FUNCTION).toContain("provenance");
  });

  it("rejects community Actors and unsupported or insecure URLs", () => {
    expect(() => assertOfficialWebScraperActor("community/jobs-scraper")).toThrow(
      "Only the Apify-maintained"
    );
    expect(() => buildWebScraperInput(["https://example.com/jobs"])).toThrow(
      "Unsupported job board host"
    );
    expect(() => buildWebScraperInput(["http://jobs.lever.co/acme"])).toThrow(
      "must use HTTPS"
    );
  });

  it("accepts Elastic's public Greenhouse board API as a real structured source", () => {
    const input = buildWebScraperInput([
      "https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=true"
    ]);
    expect(input.startUrls[0]?.url).toContain("boards-api.greenhouse.io/v1/boards/elastic/jobs");
    expect(input.pageFunction).toContain("Greenhouse board API");
    expect(input.pageFunction).toContain("payload.jobs");
  });

  it("normalizes, deduplicates, and classifies configured board URLs", () => {
    expect(
      parseJobBoardUrls([
        " https://jobs.lever.co/acme#jobs,https://jobs.lever.co/acme\n",
        "https://boards.greenhouse.io/acme"
      ])
    ).toEqual(["https://jobs.lever.co/acme", "https://boards.greenhouse.io/acme"]);
    expect(getJobBoardProvider("https://jobs.ashbyhq.com/acme")).toBe("ashby");
  });

  it("uses command-line board URLs before JOB_BOARD_URLS", () => {
    expect(
      getBoardUrlsFromCliOrEnv(
        ["--unused", "https://jobs.lever.co/cli"],
        "https://jobs.lever.co/env"
      )
    ).toEqual(["https://jobs.lever.co/cli"]);
    expect(getBoardUrlsFromCliOrEnv([], "one,two")).toEqual(["one,two"]);
  });
});

describe("Apify dataset pagination", () => {
  it("retrieves every dataset page", async () => {
    const listItems = vi.fn(async ({ offset }: { offset?: number }) => {
      const all = [job("1"), job("2"), job("3")];
      const pageItems = all.slice(offset ?? 0, (offset ?? 0) + 2);
      return {
        items: pageItems,
        total: all.length,
        offset: offset ?? 0,
        count: pageItems.length,
        limit: 2,
        desc: false
      };
    });
    const client = {
      dataset: () => ({ listItems })
    } as unknown as ApifyClient;

    const items = await listAllDatasetItems(client, "dataset-1", 2);

    expect(items.map((item) => item.jobPosting.title)).toEqual(["Job 1", "Job 2", "Job 3"]);
    expect(listItems).toHaveBeenCalledTimes(2);
    expect(listItems.mock.calls.map(([options]) => options.offset)).toEqual([0, 2]);
  });
});

describe("saved official Apify Actor task", () => {
  it("creates a Console-runnable task with the production scraper input", async () => {
    const create = vi.fn(async (fields: Record<string, unknown>) => task("task-new", fields));
    const client = taskClient({ create });

    const result = await upsertOfficialWebScraperTask({
      token: "test-token",
      startUrls: ["https://jobs.ashbyhq.com/apify"],
      client
    });

    expect(result.created).toBe(true);
    expect(result.consoleUrl).toBe(`${APIFY_TASK_CONSOLE_BASE_URL}/task-new`);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      actId: "official-actor-id",
      name: "workwink-sponsor-job-scraper",
      input: expect.objectContaining({
        runMode: "PRODUCTION",
        startUrls: [{ url: "https://jobs.ashbyhq.com/apify" }]
      })
    }));
  });

  it("updates an existing exact-name task instead of creating a duplicate", async () => {
    const update = vi.fn(async (fields: Record<string, unknown>) => task("task-existing", fields));
    const create = vi.fn();
    const client = taskClient({ existingId: "task-existing", update, create });

    const result = await upsertOfficialWebScraperTask({
      token: "test-token",
      startUrls: ["https://jobs.ashbyhq.com/apify"],
      client
    });

    expect(result.created).toBe(false);
    expect(update).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });
});

function job(id: string) {
  return {
    schemaVersion: 1 as const,
    sourceActor: OFFICIAL_WEB_SCRAPER_ACTOR_ID,
    provider: "lever" as const,
    sourceUrl: `https://jobs.lever.co/acme/${id}`,
    scrapedAt: "2026-07-31T00:00:00.000Z",
    pageUrl: `https://jobs.lever.co/acme/${id}`,
    requestedUrl: `https://jobs.lever.co/acme/${id}`,
    canonicalUrl: `https://jobs.lever.co/acme/${id}`,
    crawledAt: "2026-07-31T00:00:00.000Z",
    jobPosting: { "@type": "JobPosting", title: `Job ${id}` },
    provenance: { actor: OFFICIAL_WEB_SCRAPER_ACTOR_ID }
  };
}

function task(id: string, fields: Record<string, unknown> = {}) {
  return {
    id,
    userId: "user-1",
    actId: "official-actor-id",
    name: "workwink-sponsor-job-scraper",
    createdAt: new Date("2026-07-31T00:00:00.000Z"),
    modifiedAt: new Date("2026-07-31T00:00:00.000Z"),
    stats: { totalRuns: 0 },
    ...fields
  };
}

function taskClient(options: {
  existingId?: string;
  update?: (fields: Record<string, unknown>) => Promise<ReturnType<typeof task>>;
  create: (fields: Record<string, unknown>) => Promise<ReturnType<typeof task>> | void;
}): ApifyClient {
  const existing = options.existingId ? task(options.existingId) : undefined;
  return {
    actor: () => ({
      get: vi.fn(async () => ({
        id: "official-actor-id",
        defaultRunOptions: { build: "latest" }
      }))
    }),
    tasks: () => ({
      list: vi.fn(async () => ({ items: existing ? [existing] : [] })),
      create: options.create
    }),
    task: () => ({
      get: vi.fn(async () => existing),
      update: options.update
    })
  } as unknown as ApifyClient;
}
