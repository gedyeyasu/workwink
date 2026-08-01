import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config.js";
import {
  applicationActionSchema,
  applicationIdSchema,
  saveApplicationSchema,
  transitionApplicationSchema
} from "../contracts/application.js";
import { ElasticApplicationQueue, type ApplicationQueue } from "../services/applications.js";
import { resolveApplicationSession } from "../services/application-session.js";

type ApplicationRoutesOptions = {
  queue?: ApplicationQueue;
  sessionSecret?: string;
  secureCookies?: boolean;
};

function sessionFor(request: FastifyRequest, reply: FastifyReply, secret: string, secure: boolean): string {
  const session = resolveApplicationSession(request.headers.cookie, secret, secure);
  if (session.setCookie) reply.header("set-cookie", session.setCookie);
  reply.header("cache-control", "private, no-store");
  return session.sessionHash;
}

export const applicationRoutes: FastifyPluginAsync<ApplicationRoutesOptions> = async (app, options) => {
  const queue = options.queue ?? new ElasticApplicationQueue();
  const secret = options.sessionSecret ?? config.applicationSessionSecret;
  if (!secret) throw new Error("APPLICATION_SESSION_SECRET is required in production.");
  const secure = options.secureCookies ?? config.NODE_ENV === "production";

  app.post("/applications", {
    config: { rateLimit: { max: 45, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const sessionHash = sessionFor(request, reply, secret, secure);
    const input = saveApplicationSchema.parse(request.body ?? {});
    const result = await queue.save(sessionHash, input.jobId);
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get("/applications", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const sessionHash = sessionFor(request, reply, secret, secure);
    return reply.send(await queue.list(sessionHash));
  });

  app.post("/applications/:applicationId/transition", {
    config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    const sessionHash = sessionFor(request, reply, secret, secure);
    const params = request.params as { applicationId?: unknown };
    const id = applicationIdSchema.parse(params.applicationId);
    const { action } = transitionApplicationSchema.parse(request.body ?? {});
    return reply.send(await queue.transition(sessionHash, id, applicationActionSchema.parse(action)));
  });
};

