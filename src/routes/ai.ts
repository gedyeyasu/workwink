import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { getJobProfile, integrationProof } from "../services/ai.js";

const paramsSchema = z.object({ jobId: z.string().trim().min(1).max(200) }).strict();

export const aiRoutes: FastifyPluginAsync = async (app) => {
  app.get("/ai/jobs/:jobId/profile", {
    config: { rateLimit: { max: 20, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const { jobId } = paramsSchema.parse(request.params);
    return reply.header("cache-control", "private, max-age=300").send(await getJobProfile(jobId));
  });

  app.get("/system/proof", async (_request, reply) => {
    return reply.header("cache-control", "no-store").send(await integrationProof());
  });
};
