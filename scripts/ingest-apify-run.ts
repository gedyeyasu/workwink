import { ingestApifyRun } from "../src/services/ingestion.js";

const runId = process.argv.slice(2).find((value) => value !== "--" && !value.startsWith("-"));
if (!runId) throw new Error("Usage: pnpm ingest:run -- <APIFY_RUN_ID>");

const result = await ingestApifyRun(runId, { force: process.argv.includes("--force") });
console.log(JSON.stringify(result, null, 2));
if (result.status !== "complete") process.exitCode = 2;
