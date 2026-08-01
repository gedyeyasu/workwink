import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { apifyWebhookRoutes } from "../src/routes/apify-webhook.js";

const secret = "workwink-webhook-secret-123456";

async function appWithImporter(importer = vi.fn(async (runId: string) => ({ runId, indexed: 4 }))) {
  const app = Fastify();
  await app.register(apifyWebhookRoutes, { secret, ingestApifyRun: importer });
  return { app, importer };
}

describe("Apify success webhook", () => {
  it("rejects an unauthenticated callback", async () => {
    const { app, importer } = await appWithImporter();
    const response = await app.inject({ method: "POST", url: "/webhooks/apify", payload: {} });
    expect(response.statusCode).toBe(401);
    expect(importer).not.toHaveBeenCalled();
    await app.close();
  });

  it("passes an authenticated official Actor run to the verified importer", async () => {
    const { app, importer } = await appWithImporter();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/apify",
      headers: { "x-workwink-webhook-secret": secret },
      payload: {
        eventType: "ACTOR.RUN.SUCCEEDED",
        eventData: { actorRunId: "run-123", actorId: "apify/web-scraper" }
      }
    });
    expect(response.statusCode).toBe(200);
    expect(importer).toHaveBeenCalledWith("run-123");
    await app.close();
  });

  it("rejects callbacks that identify another Actor", async () => {
    const { app, importer } = await appWithImporter();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/apify",
      headers: { "x-workwink-webhook-secret": secret },
      payload: { eventData: { actorRunId: "run-123", actorId: "community/other" } }
    });
    expect(response.statusCode).toBe(400);
    expect(importer).not.toHaveBeenCalled();
    await app.close();
  });
});
