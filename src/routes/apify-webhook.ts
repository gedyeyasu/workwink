import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { OFFICIAL_WEB_SCRAPER_ACTOR_ID } from "../apify/web-scraper-input.js";
import { apifyWebhookSchema } from "../contracts/job.js";

type ApifyWebhookRoutesOptions = {
  secret?: string;
  ingestApifyRun?: (runId: string) => Promise<unknown>;
};

function secretsMatch(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const supplied = Buffer.from(candidate);
  const configured = Buffer.from(expected);
  return supplied.length === configured.length && timingSafeEqual(supplied, configured);
}

export const apifyWebhookRoutes: FastifyPluginAsync<ApifyWebhookRoutesOptions> = async (app, options) => {
  app.post("/webhooks/apify", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (!options.secret || !options.ingestApifyRun) {
      return reply.code(503).send({
        error: { code: "WEBHOOK_DISABLED", message: "Apify webhook ingestion is not configured.", requestId: request.id }
      });
    }

    const candidate = request.headers["x-workwink-webhook-secret"];
    if (!secretsMatch(typeof candidate === "string" ? candidate : undefined, options.secret)) {
      return reply.code(401).send({
        error: { code: "INVALID_WEBHOOK_SECRET", message: "Webhook authentication failed.", requestId: request.id }
      });
    }

    const payload = apifyWebhookSchema.parse(request.body ?? {});
    const runId = payload.eventData?.actorRunId ?? payload.resource?.id;
    const actorId = payload.eventData?.actorId ?? payload.resource?.actId;
    if (!runId) {
      return reply.code(400).send({
        error: { code: "MISSING_RUN_ID", message: "The Apify event did not include an Actor run ID.", requestId: request.id }
      });
    }
    if (actorId && actorId !== OFFICIAL_WEB_SCRAPER_ACTOR_ID) {
      return reply.code(400).send({
        error: { code: "UNSUPPORTED_ACTOR", message: "The event is not for WorkWink's allowed official Actor.", requestId: request.id }
      });
    }

    // Defense in depth: the importer resolves the run from Apify and verifies
    // SUCCEEDED status and Actor identity before reading the referenced dataset.
    const result = await options.ingestApifyRun(runId);
    return reply.code(200).send({ accepted: true, runId, ingestion: result });
  });
};
