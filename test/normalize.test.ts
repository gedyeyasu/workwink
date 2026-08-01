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
    expect(job.location).toBe("Austin, TX, US");
    expect(job.salary).toMatchObject({ annualMin: 156000, annualMax: 208000, currency: "USD", period: "hour" });
    expect(job.skills).toEqual(expect.arrayContaining(["AWS", "Go", "Kubernetes", "PostgreSQL", "Terraform"]));
    expect(job.contentHash).toHaveLength(64);
  });

  it("rejects records without core job fields instead of inventing them", () => {
    expect(() => normalizeApifyJob({ sourceUrl: "https://example.com/job" }, "run-1")).toThrow(NormalizationError);
  });

  it("keeps an absent salary unknown instead of converting null to zero", () => {
    const job = normalizeApifyJob({
      sourceUrl: "https://jobs.ashbyhq.com/linear/12345678-1234-1234-1234-123456789012",
      scrapedAt: "2026-07-31T12:00:00.000Z",
      provider: "ashby",
      jobPosting: {
        "@type": "JobPosting",
        title: "Product Engineer",
        description: "Build a reliable product with TypeScript.",
        hiringOrganization: { name: "Linear" },
        jobLocationType: "TELECOMMUTE"
      }
    }, "run-no-salary");

    expect(job.salary).toMatchObject({ min: null, max: null, annualMin: null, annualMax: null });
  });

  it("extracts a disclosed California salary range without inventing compensation", () => {
    const job = normalizeApifyJob({
      sourceUrl: "https://boards.greenhouse.io/cloudflare/jobs/456",
      scrapedAt: "2026-07-31T12:00:00.000Z",
      jobPosting: {
        "@type": "JobPosting",
        title: "Software Engineer",
        description: "Build distributed systems. The annual base salary range for this California role is $168,000 - $205,000 USD.",
        hiringOrganization: { name: "Cloudflare" },
        identifier: { value: "456" },
        jobLocation: { address: { addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } }
      }
    }, "run-california-salary");

    expect(job.salary).toEqual({
      min: 168000,
      max: 205000,
      currency: "USD",
      period: "year",
      annualMin: 168000,
      annualMax: 205000,
      sourceText: "$168,000 - $205,000 USD"
    });
  });

  it("decodes Greenhouse pay-transparency markup before extracting the range", () => {
    const job = normalizeApifyJob({
      sourceUrl: "https://job-boards.greenhouse.io/anthropic/jobs/101",
      jobPosting: {
        "@type": "JobPosting",
        title: "Full-Stack Software Engineer",
        description: "&lt;div class=&quot;content-pay-transparency&quot;&gt;&lt;p&gt;The annual compensation range for this role is listed below.&lt;/p&gt;&lt;div&gt;Annual Salary:&lt;/div&gt;&lt;span&gt;$300,000&lt;/span&gt;&lt;span&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$405,000 USD&lt;/span&gt;&lt;/div&gt;",
        hiringOrganization: { name: "Anthropic" },
        identifier: { value: "101" },
        jobLocation: { address: { addressLocality: "San Francisco", addressRegion: "CA", addressCountry: "US" } }
      }
    }, "run-greenhouse-encoded");

    expect(job.description).not.toContain("&lt;");
    expect(job.salary).toMatchObject({
      annualMin: 300000,
      annualMax: 405000,
      currency: "USD",
      sourceText: "$300,000—$405,000 USD"
    });
  });

  it("selects the California disclosure when a posting contains location-specific ranges", () => {
    const job = normalizeApifyJob({
      sourceUrl: "https://boards.greenhouse.io/example/jobs/789",
      jobPosting: {
        "@type": "JobPosting",
        title: "Backend Software Engineer",
        description: "The annual salary range in Colorado is $120k-$140k. The annual salary range in California is $155k-$190k.",
        hiringOrganization: { name: "Example Labs" },
        identifier: { value: "789" },
        jobLocation: { address: { addressLocality: "Los Angeles", addressRegion: "CA", addressCountry: "US" } }
      }
    }, "run-multi-range");

    expect(job.salary).toMatchObject({
      annualMin: 155000,
      annualMax: 190000,
      sourceText: "$155k-$190k"
    });
  });

  it("rejects dollar ranges that are not explicitly compensation", () => {
    const job = normalizeApifyJob({
      sourceUrl: "https://boards.greenhouse.io/example/jobs/999",
      jobPosting: {
        "@type": "JobPosting",
        title: "Software Engineer",
        description: "Own infrastructure serving customers with $50,000-$100,000 monthly cloud budgets.",
        hiringOrganization: { name: "Example Labs" },
        identifier: { value: "999" },
        jobLocation: { address: { addressLocality: "San Jose", addressRegion: "CA", addressCountry: "US" } }
      }
    }, "run-not-compensation");

    expect(job.salary).toMatchObject({ min: null, max: null, annualMin: null, annualMax: null });
  });
});
