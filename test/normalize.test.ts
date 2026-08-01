import { describe, expect, it } from "vitest";
import { normalizeApifyJob, NormalizationError } from "../src/domain/normalize.js";

const rawJob = {
  sourceUrl: "https://job-boards.greenhouse.io/example/jobs/123",
  scrapedAt: "2026-07-31T12:00:00.000Z",
  jobPosting: {
    "@type": "JobPosting",
    title: "Senior Platform Engineer",
    description: "<p>Build Kubernetes infrastructure using Go, AWS, Terraform and PostgreSQL.</p>",
    identifier: { value: "123" },
    hiringOrganization: { name: "Example Labs", sameAs: "https://example.com" },
    jobLocationType: "TELECOMMUTE",
    jobLocation: { address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" } },
    employmentType: "FULL_TIME",
    datePosted: "2026-07-30",
    baseSalary: { currency: "USD", value: { minValue: 75, maxValue: 100, unitText: "HOUR" } },
    url: "https://job-boards.greenhouse.io/example/jobs/123"
  }
};

describe("normalizeApifyJob", () => {
  it("normalizes JSON-LD jobs with provenance, compensation, and skills", () => {
    const job = normalizeApifyJob(rawJob, "run-1", new Date("2026-07-31T13:00:00.000Z"));
    expect(job).toMatchObject({ source: "job-boards.greenhouse.io", sourceJobId: "123", titleFamily: "Platform & Infrastructure", seniority: "Senior", workMode: "remote" });
    expect(job.salary).toMatchObject({ annualMin: 156000, annualMax: 208000, currency: "USD", period: "hour" });
    expect(job.skills).toEqual(expect.arrayContaining(["AWS", "Go", "Kubernetes", "PostgreSQL", "Terraform"]));
    expect(job.contentHash).toHaveLength(64);
  });

  it("rejects records without core job fields instead of inventing them", () => {
    expect(() => normalizeApifyJob({ sourceUrl: "https://example.com/job" }, "run-1")).toThrow(NormalizationError);
  });
});
