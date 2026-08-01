import type { FastifyPluginAsync } from "fastify";

export type DependencyStatus = {
  search: "ready" | "unavailable";
  ingestion: "ready" | "unavailable";
};

type HealthRoutesOptions = {
  startedAt: number;
  dependencies: DependencyStatus;
};

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  app.get("/health", async (_request, reply) => {
    const healthy = options.dependencies.search === "ready";
    const body = {
      status: healthy ? "ok" : "degraded",
      service: "workwink-api",
      uptimeSeconds: Math.floor((Date.now() - options.startedAt) / 1_000),
      timestamp: new Date().toISOString(),
      dependencies: options.dependencies
    };

    return reply
      .code(healthy ? 200 : 503)
      .header("cache-control", "no-store")
      .send(body);
  });
};
