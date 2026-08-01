import { requireApifyConfig, requireElasticConfig } from "../src/config.js";
import { runApifyWebScraper } from "../src/integrations/apify.js";
import { checkElasticCapabilities, setupElasticIndices } from "../src/integrations/elastic.js";
import { ingestApifyRun } from "../src/services/ingestion.js";
import { searchJobs } from "../src/services/search.js";

const apify = requireApifyConfig();
requireElasticConfig();
const boardUrls = (process.env.JOB_BOARD_URLS ?? "").split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
if (boardUrls.length === 0) throw new Error("JOB_BOARD_URLS is required for the credentialed smoke test.");

const setup = await setupElasticIndices();
const scrape = await runApifyWebScraper({ token: apify.APIFY_TOKEN, startUrls: boardUrls, maxPages: 30, maxResults: 25, maxConcurrency: 3 });
const ingestion = await ingestApifyRun(scrape.runId);
const search = await searchJobs({ query: "engineer", filters: { workModes: [], seniority: [], titleFamilies: [], skills: [], companies: [], employmentTypes: [], industries: [], minimumSalary: null, includeUnknownSalary: true, postedWithinDays: 90 }, sort: "relevance", pageSize: 10, cursor: null });
const capabilities = await checkElasticCapabilities();

if (ingestion.indexed < 1) throw new Error("Live smoke test indexed no jobs.");
if (search.items.length < 1) throw new Error("Live smoke test returned no indexed jobs.");
const firstResult = search.items[0];
if (!firstResult?.sourceUrl) throw new Error("Live smoke result is missing provenance.");

console.log(JSON.stringify({
  ok: true,
  actor: "apify/web-scraper",
  runId: scrape.runId,
  datasetId: scrape.datasetId,
  jobsIndex: setup.jobsIndex,
  indexed: ingestion.indexed,
  searchTotal: search.total,
  facetCounts: Object.fromEntries(Object.entries(search.facets).map(([key, buckets]) => [key, buckets.length])),
  firstResult: { jobId: firstResult.jobId, source: firstResult.source, sourceUrl: firstResult.sourceUrl },
  elastic: { version: capabilities.version, semanticSearchAvailable: capabilities.semanticSearchAvailable }
}, null, 2));
