import type { Client } from "@elastic/elasticsearch";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { Application, ApplicationAction } from "../src/contracts/application.js";
import type { CanonicalJob } from "../src/contracts/job.js";
import { applicationRoutes } from "../src/routes/applications.js";
import {
  buildApplicationsIndexDefinition,
  ElasticApplicationQueue,
  type ApplicationQueue
} from "../src/services/applications.js";
import { resolveApplicationSession } from "../src/services/application-session.js";

const sessionHash = "b".repeat(64);
const secret = "test-session-secret-with-at-least-thirty-two-bytes";
const applicationId = `app_${"a".repeat(40)}`;
const now = "2026-07-31T18:00:00.000Z";

const job: CanonicalJob = {
  jobId: "job-12345678",
  source: "jobs.elastic.co",
  sourceJobId: "123",
  sourceRunId: "run-1",
  sourceUrl: "https://jobs.elastic.co/jobs/123",
  applyUrl: "https://jobs.elastic.co/jobs/123/apply",
  title: "Software Engineer",
  titleFamily: "Software Engineering",
  seniority: "Mid-level",
  companyName: "Elastic",
  companyWebsite: "https://elastic.co",
  location: "Austin, Texas or Remote",
  locationCountry: "US",
  workMode: "hybrid",
  employmentType: ["full-time"],
  industries: ["technology"],
  skills: ["Elasticsearch", "TypeScript"],
  description: "Build reliable search experiences.",
  requirements: "Production software engineering experience.",
  salary: { min: null, max: null, currency: null, period: "unknown", annualMin: null, annualMax: null, sourceText: null },
  postedAt: "2026-07-30T00:00:00.000Z",
  validThrough: null,
  collectedAt: now,
  verifiedAt: now,
  status: "active",
  contentHash: "c".repeat(64),
  schemaVersion: 1,
  searchText: "Software Engineer Elastic Austin TypeScript"
};

function storedApplication(status: Application["status"] = "saved") {
  return {
    applicationId,
    sessionHash,
    jobId: job.jobId,
    jobSnapshot: {
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      workMode: job.workMode,
      applyUrl: job.applyUrl,
      sourceUrl: job.sourceUrl
    },
    status,
    savedAt: now,
    updatedAt: now,
    approvedAt: null,
    schemaVersion: 1
  } as const;
}

describe("application session", () => {
  it("reuses a valid signed cookie and rejects a tampered one", () => {
    const first = resolveApplicationSession(undefined, secret, true);
    expect(first.setCookie).toContain("HttpOnly");
    expect(first.setCookie).toContain("SameSite=Lax");
    expect(first.setCookie).toContain("Secure");

    const cookie = first.setCookie!.split(";")[0]!;
    const repeated = resolveApplicationSession(cookie, secret, true);
    expect(repeated.sessionHash).toBe(first.sessionHash);
    expect(repeated.setCookie).toBeNull();

    const tampered = resolveApplicationSession(`${cookie}x`, secret, true);
    expect(tampered.sessionHash).not.toBe(first.sessionHash);
    expect(tampered.setCookie).not.toBeNull();
  });
});

describe("application index", () => {
  it("has a strict root and strict immutable job snapshot mapping", () => {
    const definition = buildApplicationsIndexDefinition();
    expect(definition.mappings.dynamic).toBe("strict");
    expect(definition.mappings.properties?.jobSnapshot).toMatchObject({
      type: "object",
      dynamic: "strict",
      properties: {
        title: { type: "keyword", index: false },
        companyName: { type: "keyword", index: false },
        applyUrl: { type: "keyword", index: false }
      }
    });
    expect(definition.mappings.properties).toHaveProperty("sessionHash");
    expect(definition.mappings.properties).toHaveProperty("approvedAt");
  });
});

describe("ElasticApplicationQueue", () => {
  it("captures the canonical job snapshot and creates one saved application", async () => {
    const get = vi.fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce({ _source: job });
    const create = vi.fn().mockResolvedValue({ result: "created" });
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
      get,
      create
    } as unknown as Client;
    const queue = new ElasticApplicationQueue(client, {
      index: "test-applications",
      jobsAlias: "test-jobs",
      now: () => new Date(now)
    });

    const result = await queue.save(sessionHash, job.jobId);

    expect(result.created).toBe(true);
    expect(result.application).toMatchObject({
      jobId: job.jobId,
      status: "saved",
      jobSnapshot: {
        title: "Software Engineer",
        companyName: "Elastic",
        location: "Austin, Texas or Remote",
        workMode: "hybrid"
      }
    });
    const createdDocument = create.mock.calls[0]![0].document;
    expect(createdDocument.sessionHash).toBe(sessionHash);
    expect(result.application).not.toHaveProperty("sessionHash");
  });

  it("returns an existing application without fetching the job or creating a duplicate", async () => {
    const get = vi.fn().mockResolvedValue({ _source: storedApplication(), _seq_no: 1, _primary_term: 1 });
    const create = vi.fn();
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
      get,
      create
    } as unknown as Client;
    const queue = new ElasticApplicationQueue(client, { index: "test-applications", jobsAlias: "test-jobs" });

    const result = await queue.save(sessionHash, job.jobId);

    expect(result.created).toBe(false);
    expect(get).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("uses optimistic concurrency and prevents skipping approval states", async () => {
    const get = vi.fn().mockResolvedValue({ _source: storedApplication(), _seq_no: 7, _primary_term: 2 });
    const update = vi.fn().mockResolvedValue({ result: "updated" });
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
      get,
      update
    } as unknown as Client;
    const queue = new ElasticApplicationQueue(client, {
      index: "test-applications",
      now: () => new Date("2026-07-31T18:01:00.000Z")
    });

    const result = await queue.transition(sessionHash, applicationId, "package_ready");
    expect(result.changed).toBe(true);
    expect(result.application.status).toBe("package_ready");
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ if_seq_no: 7, if_primary_term: 2 }));

    await expect(queue.transition(sessionHash, applicationId, "approve")).rejects.toMatchObject({
      statusCode: 409,
      code: "INVALID_APPLICATION_TRANSITION"
    });
  });

  it("isolates list queries by the hashed session identifier", async () => {
    const search = vi.fn().mockResolvedValue({ hits: { total: { value: 1 }, hits: [{ _source: storedApplication() }] } });
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
      search
    } as unknown as Client;
    const queue = new ElasticApplicationQueue(client, { index: "test-applications" });

    const result = await queue.list(sessionHash);
    expect(result).toMatchObject({ total: 1, items: [{ jobId: job.jobId }] });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: { term: { sessionHash } } }));
  });

  it("does not reveal another session's application", async () => {
    const client = {
      indices: { exists: vi.fn().mockResolvedValue(true), create: vi.fn() },
      get: vi.fn().mockResolvedValue({ _source: storedApplication(), _seq_no: 1, _primary_term: 1 })
    } as unknown as Client;
    const queue = new ElasticApplicationQueue(client, { index: "test-applications" });
    await expect(queue.transition("d".repeat(64), applicationId, "package_ready")).rejects.toEqual(
      expect.objectContaining({ statusCode: 404, code: "APPLICATION_NOT_FOUND" })
    );
  });
});

describe("application routes", () => {
  it("sets one signed cookie and sends the same isolated session to the queue", async () => {
    const hashes: string[] = [];
    const application = storedApplication();
    const queue: ApplicationQueue = {
      save: vi.fn(async (hash) => {
        hashes.push(hash);
        const { sessionHash: _private, ...visible } = application;
        return { application: visible, created: true };
      }),
      list: vi.fn(async () => ({ items: [], total: 0 })),
      transition: vi.fn(async (_hash: string, _id: string, _action: ApplicationAction) => {
        throw new Error("not used");
      })
    };
    const app = Fastify();
    await app.register(applicationRoutes, { prefix: "/api", queue, sessionSecret: secret, secureCookies: false });

    const first = await app.inject({ method: "POST", url: "/api/applications", payload: { jobId: job.jobId } });
    expect(first.statusCode).toBe(201);
    expect(first.headers["set-cookie"]).toContain("workwink_session=");
    const setCookie = first.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie).split(";")[0]!;

    const second = await app.inject({ method: "POST", url: "/api/applications", headers: { cookie }, payload: { jobId: job.jobId } });
    expect(second.statusCode).toBe(201);
    expect(second.headers["set-cookie"]).toBeUndefined();
    expect(hashes[1]).toBe(hashes[0]);
    await app.close();
  });
});
