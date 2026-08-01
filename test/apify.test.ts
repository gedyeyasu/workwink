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
  assertOfficialWebScraperActor,
  getBoardUrlsFromCliOrEnv,
  listAllDatasetItems
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
