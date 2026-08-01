import { createHash } from "node:crypto";
import { errors, type Client, type estypes } from "@elastic/elasticsearch";
import { z } from "zod";
import { config } from "../config.js";
import {
  applicationSchema,
  applicationStatusSchema,
  jobSnapshotSchema,
  type Application,
  type ApplicationAction,
  type ApplicationStatus,
  type JobSnapshot
} from "../contracts/application.js";
import { canonicalJobSchema } from "../contracts/job.js";
import { getElasticClient } from "../integrations/elastic.js";

const internalApplicationSchema = applicationSchema.extend({
  sessionHash: z.string().length(64)
}).strict();

type InternalApplication = z.infer<typeof internalApplicationSchema>;

export const APPLICATION_TRANSITIONS: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  saved: ["package_ready"],
  package_ready: ["awaiting_approval"],
  awaiting_approval: ["approved"],
  approved: ["queued"],
  queued: ["actor_running"],
  actor_running: ["submitted", "needs_user", "failed"],
  submitted: [],
  needs_user: ["queued"],
  failed: ["queued"]
};

const actionTransition: Record<ApplicationAction, { from: ApplicationStatus; to: ApplicationStatus }> = {
  package_ready: { from: "saved", to: "package_ready" },
  request_approval: { from: "package_ready", to: "awaiting_approval" },
  approve: { from: "awaiting_approval", to: "approved" }
};

export class ApplicationQueueError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string
  ) {
    super(message);
    this.name = "ApplicationQueueError";
  }
}

function isResponseStatus(error: unknown, statusCode: number): boolean {
  if (error instanceof errors.ResponseError) return error.statusCode === statusCode;
  return error !== null && typeof error === "object" && "statusCode" in error && error.statusCode === statusCode;
}

function applicationId(sessionHash: string, jobId: string): string {
  return `app_${createHash("sha256").update(`workwink-application-v1:${sessionHash}:${jobId}`).digest("hex").slice(0, 40)}`;
}

function publicApplication(document: InternalApplication): Application {
  const { sessionHash: _sessionHash, ...application } = document;
  return applicationSchema.parse(application);
}

export function buildApplicationsIndexDefinition(): {
  settings: estypes.IndicesIndexSettings;
  mappings: estypes.MappingTypeMapping;
} {
  const privateKeyword = (): estypes.MappingProperty => ({ type: "keyword", index: false, doc_values: false, ignore_above: 4096 });
  return {
    settings: { refresh_interval: "5s" },
    mappings: {
      dynamic: "strict",
      properties: {
        applicationId: { type: "keyword" },
        sessionHash: { type: "keyword" },
        jobId: { type: "keyword" },
        jobSnapshot: {
          type: "object",
          dynamic: "strict",
          properties: {
            title: privateKeyword(),
            companyName: privateKeyword(),
            location: privateKeyword(),
            workMode: privateKeyword(),
            applyUrl: privateKeyword(),
            sourceUrl: privateKeyword()
          }
        },
        status: { type: "keyword" },
        savedAt: { type: "date" },
        updatedAt: { type: "date" },
        approvedAt: { type: "date" },
        schemaVersion: { type: "short" }
      }
    }
  };
}

export interface ApplicationQueue {
  save(sessionHash: string, jobId: string): Promise<{ application: Application; created: boolean }>;
  list(sessionHash: string): Promise<{ items: Application[]; total: number }>;
  transition(sessionHash: string, id: string, action: ApplicationAction): Promise<{ application: Application; changed: boolean }>;
}

export class ElasticApplicationQueue implements ApplicationQueue {
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly client: Client | undefined = undefined,
    private readonly options: {
      index?: string;
      jobsAlias?: string;
      now?: () => Date;
    } = {}
  ) {}

  private get index(): string {
    return this.options.index ?? config.applicationsIndex;
  }

  private get elastic(): Client {
    return this.client ?? getElasticClient();
  }

  private get jobsAlias(): string {
    return this.options.jobsAlias ?? config.jobsAlias;
  }

  private now(): string {
    return (this.options.now ?? (() => new Date()))().toISOString();
  }

  private async ensureIndex(): Promise<void> {
    this.initialization ??= (async () => {
      const exists = await this.elastic.indices.exists({ index: this.index });
      if (exists) return;
      try {
        await this.elastic.indices.create({ index: this.index, ...buildApplicationsIndexDefinition() });
      } catch (error) {
        if (!isResponseStatus(error, 400)) throw error;
        const createdByPeer = await this.elastic.indices.exists({ index: this.index });
        if (!createdByPeer) throw error;
      }
    })();
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
  }

  private async jobSnapshot(jobId: string): Promise<JobSnapshot> {
    let response: Awaited<ReturnType<Client["get"]>>;
    try {
      response = await this.elastic.get({ index: this.jobsAlias, id: jobId });
    } catch (error) {
      if (isResponseStatus(error, 404)) {
        throw new ApplicationQueueError("The selected job no longer exists.", 404, "JOB_NOT_FOUND");
      }
      throw error;
    }
    const job = canonicalJobSchema.parse(response._source);
    if (job.status !== "active") {
      throw new ApplicationQueueError("The selected job is no longer active.", 409, "JOB_NOT_ACTIVE");
    }
    return jobSnapshotSchema.parse({
      title: job.title,
      companyName: job.companyName,
      location: job.location,
      workMode: job.workMode,
      applyUrl: job.applyUrl,
      sourceUrl: job.sourceUrl
    });
  }

  private async getOwned(sessionHash: string, id: string): Promise<{
    document: InternalApplication;
    seqNo: number;
    primaryTerm: number;
  }> {
    try {
      const response = await this.elastic.get({ index: this.index, id });
      const document = internalApplicationSchema.parse(response._source);
      if (document.sessionHash !== sessionHash) throw new Error("not-owned");
      if (response._seq_no === undefined || response._primary_term === undefined) {
        throw new Error("Elasticsearch did not return optimistic concurrency metadata.");
      }
      return { document, seqNo: response._seq_no, primaryTerm: response._primary_term };
    } catch (error) {
      if (isResponseStatus(error, 404) || (error instanceof Error && error.message === "not-owned")) {
        throw new ApplicationQueueError("Application not found.", 404, "APPLICATION_NOT_FOUND");
      }
      throw error;
    }
  }

  async save(sessionHash: string, jobId: string): Promise<{ application: Application; created: boolean }> {
    await this.ensureIndex();
    const id = applicationId(sessionHash, jobId);
    try {
      const existing = await this.getOwned(sessionHash, id);
      return { application: publicApplication(existing.document), created: false };
    } catch (error) {
      if (!(error instanceof ApplicationQueueError) || error.code !== "APPLICATION_NOT_FOUND") throw error;
    }

    const snapshot = await this.jobSnapshot(jobId);
    const now = this.now();
    const document = internalApplicationSchema.parse({
      applicationId: id,
      sessionHash,
      jobId,
      jobSnapshot: snapshot,
      status: "saved",
      savedAt: now,
      updatedAt: now,
      approvedAt: null,
      schemaVersion: 1
    });

    try {
      await this.elastic.create({ index: this.index, id, document, refresh: "wait_for" });
      return { application: publicApplication(document), created: true };
    } catch (error) {
      if (!isResponseStatus(error, 409)) throw error;
      const existing = await this.getOwned(sessionHash, id);
      return { application: publicApplication(existing.document), created: false };
    }
  }

  async list(sessionHash: string): Promise<{ items: Application[]; total: number }> {
    await this.ensureIndex();
    const response = await this.elastic.search<InternalApplication>({
      index: this.index,
      size: 200,
      track_total_hits: true,
      query: { term: { sessionHash } },
      sort: [{ savedAt: "desc" }, { applicationId: "asc" }]
    });
    const total = typeof response.hits.total === "number" ? response.hits.total : (response.hits.total?.value ?? 0);
    return {
      items: response.hits.hits.map((hit) => publicApplication(internalApplicationSchema.parse(hit._source))),
      total
    };
  }

  async transition(
    sessionHash: string,
    id: string,
    action: ApplicationAction
  ): Promise<{ application: Application; changed: boolean }> {
    await this.ensureIndex();
    const transition = actionTransition[action];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await this.getOwned(sessionHash, id);
      const currentStatus = applicationStatusSchema.parse(current.document.status);
      if (currentStatus === transition.to) {
        return { application: publicApplication(current.document), changed: false };
      }
      if (currentStatus !== transition.from || !APPLICATION_TRANSITIONS[currentStatus].includes(transition.to)) {
        throw new ApplicationQueueError(
          `Cannot apply action ${action} while application is ${currentStatus}.`,
          409,
          "INVALID_APPLICATION_TRANSITION"
        );
      }

      const updatedAt = this.now();
      const patch = {
        status: transition.to,
        updatedAt,
        ...(transition.to === "approved" ? { approvedAt: updatedAt } : {})
      };
      try {
        await this.elastic.update({
          index: this.index,
          id,
          if_seq_no: current.seqNo,
          if_primary_term: current.primaryTerm,
          doc: patch,
          refresh: "wait_for"
        });
        const document = internalApplicationSchema.parse({ ...current.document, ...patch });
        return { application: publicApplication(document), changed: true };
      } catch (error) {
        if (!isResponseStatus(error, 409) || attempt === 2) throw error;
      }
    }
    throw new ApplicationQueueError("Application was updated concurrently. Retry the request.", 409, "APPLICATION_CONFLICT");
  }
}
