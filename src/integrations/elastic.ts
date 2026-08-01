import { Client, errors } from "@elastic/elasticsearch";
import type { estypes } from "@elastic/elasticsearch";
import { config, requireElasticConfig } from "../config.js";
import type { CanonicalJob } from "../contracts/job.js";

export const JOBS_INDEX_VERSION = 1;

export type ElasticJobDocument = CanonicalJob;

export interface BulkUpsertFailure {
  jobId: string;
  status: number;
  type?: string;
  reason: string;
}

export interface BulkUpsertResult {
  attempted: number;
  succeeded: number;
  failed: BulkUpsertFailure[];
  tookMs: number;
}

export interface ElasticCapabilities {
  ok: boolean;
  clusterName?: string;
  version?: string;
  jobsIndexReady: boolean;
  inferenceConfigured: boolean;
  semanticSearchAvailable: boolean;
  error?: string;
}

let sharedClient: Client | undefined;

export function createElasticClient(): Client {
  const elastic = requireElasticConfig();
  const node = elastic.ELASTICSEARCH_URL;
  const apiKey = elastic.elasticApiKey;
  if (!node) throw new Error("ELASTICSEARCH_URL is required for live search.");
  if (!apiKey) throw new Error("ELASTICSEARCH_API_KEY or ELASTIC_TOKEN is required for live search.");
  return new Client({
    node,
    auth: { apiKey },
    maxRetries: 3,
    requestTimeout: 90_000,
    sniffOnStart: false
  });
}

export function getElasticClient(): Client {
  sharedClient ??= createElasticClient();
  return sharedClient;
}

export function concreteJobsIndexName(prefix = config.ELASTICSEARCH_INDEX_PREFIX): string {
  return `${prefix}-jobs-v${JOBS_INDEX_VERSION}`;
}

function keyword(ignoreAbove = 256): estypes.MappingProperty {
  return { type: "keyword", normalizer: "lowercase_normalizer", ignore_above: ignoreAbove };
}

export function buildJobsIndexDefinition(inferenceId?: string): {
  settings: estypes.IndicesIndexSettings;
  mappings: estypes.MappingTypeMapping;
} {
  const properties: Record<string, estypes.MappingProperty> = {
    jobId: keyword(),
    source: keyword(),
    sourceJobId: keyword(),
    sourceRunId: keyword(),
    sourceUrl: { type: "keyword", index: false, doc_values: false, ignore_above: 4096 },
    applyUrl: { type: "keyword", index: false, doc_values: false, ignore_above: 4096 },
    title: { type: "text", analyzer: "standard", fields: { keyword: keyword() } },
    companyName: { type: "text", analyzer: "standard", fields: { keyword: keyword() } },
    companyWebsite: { type: "keyword", index: false, doc_values: false, ignore_above: 4096 },
    location: { type: "text", analyzer: "standard", fields: { keyword: keyword(512) } },
    locationCountry: keyword(),
    workMode: keyword(),
    employmentType: keyword(),
    seniority: keyword(),
    titleFamily: keyword(),
    skills: keyword(512),
    industries: keyword(512),
    description: { type: "text", analyzer: "standard" },
    requirements: { type: "text", analyzer: "standard" },
    salary: {
      type: "object",
      dynamic: "strict",
      properties: {
        min: { type: "scaled_float", scaling_factor: 100 },
        max: { type: "scaled_float", scaling_factor: 100 },
        currency: keyword(16),
        period: keyword(32),
        annualMin: { type: "scaled_float", scaling_factor: 100 },
        annualMax: { type: "scaled_float", scaling_factor: 100 },
        sourceText: { type: "text", index: false }
      }
    },
    postedAt: { type: "date" },
    validThrough: { type: "date" },
    collectedAt: { type: "date" },
    verifiedAt: { type: "date" },
    status: keyword(),
    contentHash: keyword(128),
    schemaVersion: { type: "short" },
    searchText: { type: "text", analyzer: "standard" }
  };

  if (inferenceId) {
    properties.semanticText = { type: "semantic_text", inference_id: inferenceId };
  }

  return {
    settings: {
      refresh_interval: "5s",
      analysis: {
        normalizer: {
          lowercase_normalizer: { type: "custom", filter: ["lowercase"] }
        }
      }
    },
    mappings: { dynamic: "strict", properties }
  };
}

export function buildRunsIndexDefinition(): {
  settings: estypes.IndicesIndexSettings;
  mappings: estypes.MappingTypeMapping;
} {
  return {
    settings: {
      analysis: {
        normalizer: {
          lowercase_normalizer: { type: "custom", filter: ["lowercase"] }
        }
      }
    },
    mappings: {
      dynamic: "strict",
      properties: {
        runId: keyword(),
        actorId: keyword(),
        datasetId: keyword(),
        status: keyword(),
        startedAt: { type: "date" },
        finishedAt: { type: "date" },
        collected: { type: "integer" },
        accepted: { type: "integer" },
        rejected: { type: "integer" },
        indexed: { type: "integer" },
        failed: { type: "integer" },
        error: { type: "text", index: false },
        cursor: keyword(1024),
        rejections: {
          type: "nested",
          dynamic: "strict",
          properties: {
            index: { type: "integer" },
            code: keyword(),
            message: { type: "text", index: false }
          }
        },
        bulkFailures: {
          type: "nested",
          dynamic: "strict",
          properties: {
            jobId: keyword(),
            status: { type: "integer" },
            reason: { type: "text", index: false }
          }
        }
      }
    }
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof errors.ResponseError && error.statusCode === 404;
}

async function aliasesFor(client: Client, aliases: string[]): Promise<Record<string, { aliases?: Record<string, unknown> }>> {
  try {
    return (await client.indices.getAlias({
      name: aliases,
      allow_no_indices: true,
      ignore_unavailable: true
    })) as Record<string, { aliases?: Record<string, unknown> }>;
  } catch (error) {
    if (isNotFound(error)) return {};
    throw error;
  }
}

export async function setupElasticIndices(client = getElasticClient()): Promise<{
  jobsIndex: string;
  created: boolean;
  aliasesUpdated: boolean;
  runsIndexCreated: boolean;
}> {
  const jobsIndex = concreteJobsIndexName();
  const exists = await client.indices.exists({ index: jobsIndex });
  let created = false;

  if (!exists) {
    await client.indices.create({
      index: jobsIndex,
      ...buildJobsIndexDefinition(config.ELASTICSEARCH_INFERENCE_ID)
    });
    created = true;
  }

  const existingAliases = await aliasesFor(client, [config.jobsAlias, config.jobsWriteAlias]);
  const actions: estypes.IndicesUpdateAliasesAction[] = [];
  for (const [index, metadata] of Object.entries(existingAliases)) {
    for (const alias of [config.jobsAlias, config.jobsWriteAlias]) {
      if (index !== jobsIndex && metadata.aliases?.[alias]) {
        actions.push({ remove: { index, alias } });
      }
    }
  }

  const currentAliases = existingAliases[jobsIndex]?.aliases ?? {};
  if (!currentAliases[config.jobsAlias]) {
    actions.push({ add: { index: jobsIndex, alias: config.jobsAlias } });
  }
  const writeAlias = currentAliases[config.jobsWriteAlias] as { is_write_index?: boolean } | undefined;
  if (!writeAlias?.is_write_index) {
    actions.push({ add: { index: jobsIndex, alias: config.jobsWriteAlias, is_write_index: true } });
  }
  if (actions.length > 0) await client.indices.updateAliases({ actions });

  const runsExists = await client.indices.exists({ index: config.runsIndex });
  if (!runsExists) {
    await client.indices.create({ index: config.runsIndex, ...buildRunsIndexDefinition() });
  }

  return {
    jobsIndex,
    created,
    aliasesUpdated: actions.length > 0,
    runsIndexCreated: !runsExists
  };
}

function indexableDocument(job: ElasticJobDocument): ElasticJobDocument & { semanticText?: string } {
  if (!config.ELASTICSEARCH_INFERENCE_ID) return job;
  return { ...job, semanticText: job.searchText };
}

function errorReason(error: estypes.ErrorCause | undefined): string {
  if (!error) return "Unknown Elasticsearch bulk failure";
  if (typeof error.reason === "string") return error.reason;
  return JSON.stringify(error);
}

export async function bulkUpsertJobs(
  jobs: readonly ElasticJobDocument[],
  options: { client?: Client; batchSize?: number; refresh?: boolean } = {}
): Promise<BulkUpsertResult> {
  const client = options.client ?? getElasticClient();
  const batchSize = options.batchSize ?? 500;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 5_000) {
    throw new RangeError("batchSize must be an integer between 1 and 5000");
  }

  const failed: BulkUpsertFailure[] = [];
  let tookMs = 0;
  for (let offset = 0; offset < jobs.length; offset += batchSize) {
    const batch = jobs.slice(offset, offset + batchSize);
    const operations: estypes.BulkRequest["operations"] = [];
    for (const job of batch) {
      operations.push(
        { update: { _index: config.jobsWriteAlias, _id: job.jobId } },
        { doc: indexableDocument(job), doc_as_upsert: true }
      );
    }

    const response = await client.bulk({
      operations,
      refresh: options.refresh ? "wait_for" : false,
      require_alias: true
    });
    tookMs += response.took;

    response.items.forEach((operation, index) => {
      const item = operation.update;
      if (!item || item.status < 300) return;
      const job = batch[index];
      if (!job) return;
      failed.push({
        jobId: job.jobId,
        status: item.status,
        ...(item.error?.type ? { type: item.error.type } : {}),
        reason: errorReason(item.error)
      });
    });
  }

  return {
    attempted: jobs.length,
    succeeded: jobs.length - failed.length,
    failed,
    tookMs
  };
}

export async function checkElasticCapabilities(client = getElasticClient()): Promise<ElasticCapabilities> {
  try {
    const info = await client.info();
    const jobsIndexReady = await client.indices.exists({ index: config.jobsAlias });
    const inferenceConfigured = Boolean(config.ELASTICSEARCH_INFERENCE_ID);
    let semanticSearchAvailable = false;

    if (config.ELASTICSEARCH_INFERENCE_ID) {
      try {
        await client.inference.get({ inference_id: config.ELASTICSEARCH_INFERENCE_ID });
        semanticSearchAvailable = true;
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }

    return {
      ok: true,
      clusterName: info.cluster_name,
      version: info.version.number,
      jobsIndexReady,
      inferenceConfigured,
      semanticSearchAvailable
    };
  } catch (error) {
    return {
      ok: false,
      jobsIndexReady: false,
      inferenceConfigured: Boolean(config.ELASTICSEARCH_INFERENCE_ID),
      semanticSearchAvailable: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
