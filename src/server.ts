import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyError } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { aiRoutes } from "./routes/ai.js";
import { adminRoutes, type TriggerIngestion } from "./routes/admin.js";
import { apifyWebhookRoutes } from "./routes/apify-webhook.js";
import { healthRoutes, type DependencyStatus } from "./routes/health.js";
import { resumeRoutes } from "./routes/resume.js";
import { searchRoutes, SearchUnavailableError, type SearchJobs } from "./routes/search.js";

const startedAt = Date.now();
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const webRootCandidates = [path.resolve(process.cwd(), "web"), path.resolve(sourceDirectory, "../web"), path.resolve(sourceDirectory, "../../web")];
const webRoot = webRootCandidates.find((candidate) => existsSync(candidate)) ?? webRootCandidates[0]!;

type RuntimeModule = Record<string, unknown>;
type IngestApifyRun = (runId: string) => Promise<unknown>;

async function loadRuntimeModule(relativePath: string): Promise<RuntimeModule | undefined> {
  try {
    return await import(relativePath) as RuntimeModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (config.NODE_ENV !== "test") console.warn(`[workwink] Optional module ${relativePath} was not loaded: ${message}`);
    return undefined;
  }
}

function callable<T>(module: RuntimeModule | undefined, names: string[]): T | undefined {
  for (const name of names) {
    if (typeof module?.[name] === "function") return module[name] as T;
  }
  return undefined;
}

export async function buildServer() {
  const app = Fastify({
    logger: config.LOG_LEVEL === "silent" ? false : { level: config.LOG_LEVEL },
    trustProxy: true,
    bodyLimit: 32 * 1_024,
    requestIdHeader: "x-request-id"
  });

  await app.register(cors, {
    origin: config.NODE_ENV === "production" ? false : /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/,
    methods: ["GET", "POST", "OPTIONS"]
  });
  await app.register(rateLimit, {
    max: 120,
    timeWindow: "1 minute",
    errorResponseBuilder: (request, context) => ({
      error: {
        code: "RATE_LIMITED",
        message: `Too many requests. Try again in ${context.after}.`,
        requestId: request.id
      }
    })
  });
  await app.register(multipart, {
    limits: {
      fileSize: 5 * 1_024 * 1_024,
      files: 1,
      fields: 1,
      parts: 2,
      fieldSize: 16 * 1_024
    },
    throwFileSizeLimit: true
  });

  app.setErrorHandler((error: FastifyError | ZodError | Error, request, reply) => {
    if (error instanceof ZodError || ("issues" in error && Array.isArray(error.issues))) {
      const issues = (error as ZodError).issues;
      return reply.code(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "The request did not pass validation.",
          requestId: request.id,
          details: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
    }

    const known = error as Error & { statusCode?: number; code?: string };
    const statusCode = known.statusCode && known.statusCode >= 400 && known.statusCode < 600 ? known.statusCode : 500;
    if (statusCode >= 500) request.log.error({ err: error }, "Request failed");
    return reply.code(statusCode).send({
      error: {
        code: known.code ?? (statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR"),
        message: statusCode >= 500 && config.NODE_ENV === "production"
          ? "The service could not complete the request."
          : known.message,
        requestId: request.id
      }
    });
  });

  const searchModule = await loadRuntimeModule("./services/search.js");
  const ingestionModule = await loadRuntimeModule("./services/ingestion.js");
  const liveSearch = callable<SearchJobs>(searchModule, ["searchJobs", "search"]);
  const ingestionHandler = callable<TriggerIngestion>(ingestionModule, ["triggerIngestion", "runIngestion", "ingest"]);
  const ingestApifyRun = callable<IngestApifyRun>(ingestionModule, ["ingestApifyRun"]);
  const triggerIngestion = ingestionHandler ?? (ingestApifyRun
    ? ((input) => ingestApifyRun(input.runId)) satisfies TriggerIngestion
    : undefined);
  const elasticConfigured = Boolean(config.ELASTICSEARCH_URL && config.elasticApiKey);
  const dependencies: DependencyStatus = {
    search: liveSearch && elasticConfigured ? "ready" : "unavailable",
    ingestion: triggerIngestion && elasticConfigured && config.APIFY_TOKEN ? "ready" : "unavailable"
  };

  const searchJobs: SearchJobs = liveSearch ?? (async () => {
    throw new SearchUnavailableError();
  });

  await app.register(healthRoutes, { prefix: "/api", startedAt, dependencies });
  await app.register(searchRoutes, { prefix: "/api", searchJobs });
  await app.register(resumeRoutes, { prefix: "/api" });
  await app.register(aiRoutes, { prefix: "/api" });
  await app.register(adminRoutes, {
    prefix: "/api",
    ...(config.ADMIN_TOKEN ? { adminToken: config.ADMIN_TOKEN } : {}),
    ...(triggerIngestion ? { triggerIngestion } : {})
  });
  await app.register(apifyWebhookRoutes, {
    prefix: "/api",
    ...(config.APIFY_WEBHOOK_SECRET ? { secret: config.APIFY_WEBHOOK_SECRET } : {}),
    ...(ingestApifyRun ? { ingestApifyRun } : {})
  });

  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: "/",
    cacheControl: config.NODE_ENV === "production",
    maxAge: config.NODE_ENV === "production" ? "1h" : 0,
    wildcard: false
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "NOT_FOUND", message: "API route not found.", requestId: request.id }
      });
    }
    return reply.code(404).type("text/plain").send("Not found");
  });

  return app;
}

async function start() {
  const app = await buildServer();
  const close = async (signal: string) => {
    app.log.info({ signal }, "Shutting down");
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void start();
}
