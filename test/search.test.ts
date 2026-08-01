import { describe, expect, it } from "vitest";
import { searchRequestSchema } from "../src/contracts/job.js";
import { buildElasticSearchRequest, buildFilterContext } from "../src/services/search.js";

describe("Elasticsearch search request", () => {
  const input = searchRequestSchema.parse({
    query: "search engineer",
    filters: {
      workModes: ["remote"],
      skills: ["Elasticsearch"],
      companies: ["Example"],
      minimumSalary: 120_000,
      includeUnknownSalary: false,
      postedWithinDays: 30
    },
    pageSize: 20
  });

  it("puts structured constraints into filter context", () => {
    const filters = buildFilterContext(input, undefined, new Date("2026-07-31T00:00:00.000Z"));

    expect(filters).toContainEqual({ term: { status: "active" } });
    expect(filters).toContainEqual({ terms: { workMode: ["remote"] } });
    expect(filters).toContainEqual({ range: { "salary.annualMax": { gte: 120_000 } } });
    expect(filters).toContainEqual({ range: { postedAt: { gte: "2026-07-01T00:00:00.000Z" } } });
  });

  it("builds hybrid retrieval and disjunctive facet aggregations", () => {
    const request = buildElasticSearchRequest(input, "hybrid", undefined, new Date("2026-07-31T00:00:00.000Z"));
    const query = request.query as any;
    const aggs = request.aggs as any;

    expect(query.bool.should).toContainEqual({
      semantic: { field: "semanticText", query: "search engineer", boost: 1.5 }
    });
    expect(aggs.workModes.global).toEqual({});
    const workModeFilters = aggs.workModes.aggs.filtered.filter.bool.filter;
    expect(workModeFilters).not.toContainEqual({ terms: { workMode: ["remote"] } });
    expect(workModeFilters).toContainEqual({ terms: { skills: ["Elasticsearch"] } });
    expect(request.sort).toEqual(["_score", { postedAt: { order: "desc", missing: "_last" } }, { jobId: "asc" }]);
  });
});
