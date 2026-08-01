import "dotenv/config";
import { z } from "zod";

const optionalUrl = z.string().url().optional();

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4173),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APIFY_TOKEN: z.string().min(1).optional(),
  APIFY_ACTOR_ID: z.string().min(1).default("apify/web-scraper"),
  APIFY_TASK_ID: z.string().min(1).optional(),
  APIFY_SCHEDULE_ID: z.string().min(1).optional(),
  APIFY_WEBHOOK_URL: optionalUrl,
  APIFY_WEBHOOK_SECRET: z.string().min(24).optional(),
  ELASTICSEARCH_URL: optionalUrl,
  ELASTICSEARCH_API_KEY: z.string().min(1).optional(),
  ELASTIC_TOKEN: z.string().min(1).optional(),
  ELASTICSEARCH_INDEX_PREFIX: z.string().regex(/^[a-z0-9-]+$/).default("workwink"),
  ELASTICSEARCH_INFERENCE_ID: z.string().min(1).optional(),
  ELASTIC_NVIDIA_INFERENCE_ID: z.string().min(1).default("workwink-nemotron"),
  ELASTIC_SEARCH_MODE: z.enum(["lexical", "hybrid"]).default("lexical"),
  ADMIN_TOKEN: z.string().min(24).optional(),
  CURSOR_SECRET: z.string().min(32).optional()
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(`Invalid configuration: ${parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`);
}

export const config = {
  ...parsed.data,
  elasticApiKey: parsed.data.ELASTICSEARCH_API_KEY ?? parsed.data.ELASTIC_TOKEN,
  jobsAlias: `${parsed.data.ELASTICSEARCH_INDEX_PREFIX}-jobs-read`,
  jobsWriteAlias: `${parsed.data.ELASTICSEARCH_INDEX_PREFIX}-jobs-write`,
  runsIndex: `${parsed.data.ELASTICSEARCH_INDEX_PREFIX}-ingestion-runs`,
  jobProfilesIndex: `${parsed.data.ELASTICSEARCH_INDEX_PREFIX}-ai-job-profiles-v1`
};

export function requireApifyConfig() {
  if (!config.APIFY_TOKEN) throw new Error("APIFY_TOKEN is required for live scraping.");
  return { ...config, APIFY_TOKEN: config.APIFY_TOKEN };
}

export function requireElasticConfig() {
  if (!config.ELASTICSEARCH_URL) throw new Error("ELASTICSEARCH_URL is required for live search.");
  if (!config.elasticApiKey) throw new Error("ELASTICSEARCH_API_KEY or ELASTIC_TOKEN is required for live search.");
  if (config.ELASTIC_SEARCH_MODE === "hybrid" && !config.ELASTICSEARCH_INFERENCE_ID) {
    throw new Error("ELASTICSEARCH_INFERENCE_ID is required when ELASTIC_SEARCH_MODE=hybrid.");
  }
  return {
    ...config,
    ELASTICSEARCH_URL: config.ELASTICSEARCH_URL,
    elasticApiKey: config.elasticApiKey
  };
}
