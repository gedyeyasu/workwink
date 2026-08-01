import type { FastifyPluginAsync } from "fastify";
import { searchRequestSchema, type SearchRequest, type SearchResponse } from "../contracts/job.js";

export type SearchJobs = (request: SearchRequest) => Promise<SearchResponse>;

export class SearchUnavailableError extends Error {
  readonly statusCode = 503;
  readonly code = "SEARCH_UNAVAILABLE";

  constructor(message = "Live job search is temporarily unavailable.") {
    super(message);
    this.name = "SearchUnavailableError";
  }
}

type SearchRoutesOptions = {
  searchJobs: SearchJobs;
};

export const searchRoutes: FastifyPluginAsync<SearchRoutesOptions> = async (app, options) => {
  app.post("/search/jobs", {
    config: {
      rateLimit: {
        max: 45,
        timeWindow: "1 minute"
      }
    }
  }, async (request, reply) => {
    const input = searchRequestSchema.parse(request.body ?? {});
    let result: SearchResponse;
    try {
      result = await options.searchJobs(input);
    } catch (error) {
      if (error && typeof error === "object" && "statusCode" in error) throw error;
      throw new SearchUnavailableError(error instanceof Error ? error.message : undefined);
    }

    return reply
      .header("cache-control", "private, no-store")
      .send(result);
  });
};
