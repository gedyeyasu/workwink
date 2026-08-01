import type { Client } from "@elastic/elasticsearch";
import { describe, expect, it, vi } from "vitest";
import type { CanonicalJob } from "../src/contracts/job.js";
import { buildJobsIndexDefinition, bulkUpsertJobs } from "../src/integrations/elastic.js";

const job: CanonicalJob = {
  jobId: "job-12345678",
  source: "example.com",
  sourceJobId: "123",
  sourceRunId: "run-1",
  sourceUrl: "https://example.com/jobs/123",
  applyUrl: "https://example.com/jobs/123/apply",
  title: "Senior Search Engineer",
  titleFamily: "Software Engineering",
  seniority: "Senior",
  companyName: "Example",
  companyWebsite: null,
  location: "Remote",
  locationCountry: null,
  workMode: "remote",
  employmentType: ["full-time"],
  industries: ["technology"],
  skills: ["Elasticsearch", "TypeScript"],
  description: "Build search systems.",
  requirements: "Experience with distributed systems.",
  salary: {
    min: 100_000,
    max: 150_000,
    currency: "USD",
    period: "year",
    annualMin: 100_000,
    annualMax: 150_000,
    sourceText: "$100k-$150k"
  },
  postedAt: "2026-07-30T00:00:00.000Z",
  validThrough: null,
  collectedAt: "2026-07-31T00:00:00.000Z",
  verifiedAt: "2026-07-31T00:00:00.000Z",
  status: "active",
  contentHash: "a".repeat(64),
  schemaVersion: 1,
  searchText: "Senior Search Engineer Elasticsearch TypeScript"
};

describe("Elasticsearch index definition", () => {
  it("uses strict canonical mappings and conditionally adds semantic_text", () => {
    const lexical = buildJobsIndexDefinition();
    const semantic = buildJobsIndexDefinition("workwink-elser");

    expect(lexical.mappings.dynamic).toBe("strict");
    expect(lexical.mappings.properties).not.toHaveProperty("semanticText");
    expect(semantic.mappings.properties?.semanticText).toEqual({
      type: "semantic_text",
      inference_id: "workwink-elser"
    });
    expect(semantic.mappings.properties?.salary).toMatchObject({ type: "object", dynamic: "strict" });
  });
});

describe("bulkUpsertJobs", () => {
  it("uses the write alias and reports item-level partial failures", async () => {
    const bulk = vi.fn().mockResolvedValue({
      took: 7,
      errors: true,
      items: [
        { update: { _index: "jobs", _id: job.jobId, status: 201, result: "created" } },
        { update: { _index: "jobs", _id: "job-failed", status: 400, error: { type: "strict_dynamic_mapping_exception", reason: "bad field" } } }
      ]
    });
    const client = { bulk } as unknown as Client;
    const second = { ...job, jobId: "job-failed" };

    const result = await bulkUpsertJobs([job, second], { client, refresh: true });

    expect(result).toEqual({
      attempted: 2,
      succeeded: 1,
      failed: [{ jobId: "job-failed", status: 400, type: "strict_dynamic_mapping_exception", reason: "bad field" }],
      tookMs: 7
    });
    expect(bulk).toHaveBeenCalledOnce();
    const request = bulk.mock.calls[0]?.[0];
    expect(request).toMatchObject({ refresh: "wait_for", require_alias: true });
    expect(request.operations[0].update._id).toBe(job.jobId);
    expect(request.operations[1].doc_as_upsert).toBe(true);
  });
});
