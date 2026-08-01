import { timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

const ingestionRequestSchema = z.object({
  runId: z.string().trim().min(1).max(100),
  reason: z.string().trim().min(1).max(120).default("manual"),
  waitForFinish: z.boolean().default(false)
}).strict();

export type IngestionRequest = z.infer<typeof ingestionRequestSchema>;
export type TriggerIngestion = (request: IngestionRequest) => Promise<unknown>;

type AdminRoutesOptions = {
  adminToken?: string;
  triggerIngestion?: TriggerIngestion;
};

function tokensMatch(candidate: string | undefined, expected: string): boolean {
  if (!candidate) return false;
  const candidateBuffer = Buffer.from(candidate);
  const expectedBuffer = Buffer.from(expected);
  return candidateBuffer.length === expectedBuffer.length && timingSafeEqual(candidateBuffer, expectedBuffer);
}

export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  app.post("/admin/ingestion", {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: "1 minute"
      }
    }
  }, async (request, reply) => {
    if (!options.adminToken) {
      return reply.code(503).send({
        error: {
          code: "ADMIN_DISABLED",
          message: "Administrative ingestion is not configured.",
          requestId: request.id
        }
      });
    }

    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const headerToken = request.headers["x-admin-token"];
    const candidate = bearer ?? (typeof headerToken === "string" ? headerToken : undefined);
    if (!tokensMatch(candidate, options.adminToken)) {
      return reply.code(401).header("www-authenticate", "Bearer").send({
        error: {
          code: "UNAUTHORIZED",
          message: "A valid administrator token is required.",
          requestId: request.id
        }
      });
    }

    if (!options.triggerIngestion) {
      return reply.code(501).send({
        error: {
          code: "INGESTION_UNAVAILABLE",
          message: "The live ingestion service is unavailable.",
          requestId: request.id
        }
      });
    }

    const input = ingestionRequestSchema.parse(request.body ?? {});
    const result = await options.triggerIngestion(input);
    return reply.code(input.waitForFinish ? 200 : 202).send(result);
  });
};
