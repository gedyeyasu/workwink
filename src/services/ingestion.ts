import { requireApifyConfig, config } from "../config.js";
import type { CanonicalJob } from "../contracts/job.js";
import { normalizeApifyJob, NormalizationError } from "../domain/normalize.js";
import { OFFICIAL_WEB_SCRAPER_ACTOR_ID } from "../apify/web-scraper-input.js";
import { createApifyClient, listAllDatasetItems } from "../integrations/apify.js";
import { bulkUpsertJobs, getElasticClient, setupElasticIndices } from "../integrations/elastic.js";

export type IngestionRejection = { index: number; code: string; message: string };
export type IngestionResult = {
  runId: string;
  datasetId: string;
  collected: number;
  accepted: number;
  rejected: number;
  indexed: number;
  failed: number;
  status: "complete" | "partial";
  rejections: IngestionRejection[];
  bulkFailures: Array<{ jobId: string; status: number; reason: string }>;
};

type RunState = IngestionResult & { actorId: string; startedAt: string; finishedAt: string };

export async function ingestApifyRun(runId: string, options: { force?: boolean } = {}): Promise<IngestionResult> {
  if (!runId.trim()) throw new Error("An Apify run id is required.");
  const apifyConfig = requireApifyConfig();
  const apify = createApifyClient(apifyConfig.APIFY_TOKEN);
  const elastic = getElasticClient();
  await setupElasticIndices(elastic);

  const existing = await getRunState(runId);
  if (existing?.status === "complete" && !options.force) return stripRunState(existing);

  const [run, actor] = await Promise.all([
    apify.run(runId).get(),
    apify.actor(OFFICIAL_WEB_SCRAPER_ACTOR_ID).get()
  ]);
  if (!run) throw new Error(`Apify run ${runId} was not found.`);
  if (!actor || run.actId !== actor.id) throw new Error(`Run ${runId} does not belong to the allowed official ${OFFICIAL_WEB_SCRAPER_ACTOR_ID} Actor.`);
  if (run.status !== "SUCCEEDED") throw new Error(`Run ${runId} is not ingestible because its status is ${run.status}.`);
  if (!run.defaultDatasetId) throw new Error(`Run ${runId} has no default dataset.`);

  const startedAt = new Date().toISOString();
  await writeRunState(runId, { runId, actorId: actor.id, datasetId: run.defaultDatasetId, status: "partial", startedAt, finishedAt: startedAt, collected: 0, accepted: 0, rejected: 0, indexed: 0, failed: 0, rejections: [], bulkFailures: [] });

  try {
    const items = await listAllDatasetItems(apify, run.defaultDatasetId);
    const jobs: CanonicalJob[] = [];
    const rejections: IngestionRejection[] = [];
    items.forEach((item, index) => {
      try { jobs.push(normalizeApifyJob(item, runId)); }
      catch (error) {
        rejections.push({ index, code: error instanceof NormalizationError ? error.code : "unknown", message: error instanceof Error ? error.message : String(error) });
      }
    });

    const bulk = await bulkUpsertJobs(jobs, { client: elastic, refresh: true });
    const status = bulk.failed.length === 0 ? "complete" : "partial";
    const result: IngestionResult = {
      runId, datasetId: run.defaultDatasetId, collected: items.length, accepted: jobs.length, rejected: rejections.length,
      indexed: bulk.succeeded, failed: bulk.failed.length, status, rejections: rejections.slice(0, 25),
      bulkFailures: bulk.failed.slice(0, 25).map(({ jobId, status: failureStatus, reason }) => ({ jobId, status: failureStatus, reason }))
    };
    await writeRunState(runId, { ...result, actorId: actor.id, startedAt, finishedAt: new Date().toISOString() });
    return result;
  } catch (error) {
    await elastic.index({
      index: config.runsIndex, id: runId, refresh: true,
      document: { runId, actorId: actor.id, datasetId: run.defaultDatasetId, status: "failed", startedAt, finishedAt: new Date().toISOString(), collected: 0, accepted: 0, rejected: 0, indexed: 0, failed: 1, error: error instanceof Error ? error.message : String(error), rejections: [], bulkFailures: [] }
    });
    throw error;
  }
}

async function getRunState(runId: string): Promise<RunState | null> {
  try {
    const response = await getElasticClient().get<RunState>({ index: config.runsIndex, id: runId });
    return response._source ?? null;
  } catch (error) {
    const statusCode = (error as { meta?: { statusCode?: number } }).meta?.statusCode;
    if (statusCode === 404) return null;
    throw error;
  }
}

async function writeRunState(runId: string, state: RunState) {
  await getElasticClient().index({ index: config.runsIndex, id: runId, document: state, refresh: true });
}

function stripRunState(state: RunState): IngestionResult {
  const { actorId: _actorId, startedAt: _startedAt, finishedAt: _finishedAt, ...result } = state;
  return result;
}
