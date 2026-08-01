import { errors } from "@elastic/elasticsearch";
import { z } from "zod";
import { config } from "../config.js";
import type { CanonicalJob } from "../contracts/job.js";
import { getElasticClient } from "../integrations/elastic.js";

const jobProfileSchema = z.object({
  oneLiner: z.string().trim().min(10).max(220),
  mission: z.string().trim().min(10).max(500),
  highlights: z.array(z.string().trim().min(3).max(220)).min(2).max(5),
  mustHaveSkills: z.array(z.string().trim().min(1).max(80)).max(10),
  whyYouMightLoveIt: z.string().trim().min(10).max(400),
  interviewSignals: z.array(z.string().trim().min(3).max(180)).max(6),
  evidence: z.array(z.object({
    claim: z.string().trim().min(3).max(180),
    sourceText: z.string().trim().min(3).max(300)
  }).strict()).max(10)
}).strict();

export type JobProfile = z.infer<typeof jobProfileSchema> & {
  jobId: string;
  sourceContentHash: string;
  provider: "elastic-nvidia";
  model: "nemotron";
  promptVersion: "workwink-job-profile-v1";
  generatedAt: string;
};

class AiProfileError extends Error {
  readonly statusCode: number;
  readonly code: string;
  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

let indexReady: Promise<void> | undefined;

async function ensureProfileIndex(): Promise<void> {
  indexReady ??= (async () => {
    const client = getElasticClient();
    if (await client.indices.exists({ index: config.jobProfilesIndex })) return;
    try {
      await client.indices.create({
        index: config.jobProfilesIndex,
        mappings: {
          dynamic: "strict",
          properties: {
            jobId: { type: "keyword" },
            sourceContentHash: { type: "keyword" },
            oneLiner: { type: "text" },
            mission: { type: "text" },
            highlights: { type: "text" },
            mustHaveSkills: { type: "keyword" },
            whyYouMightLoveIt: { type: "text" },
            interviewSignals: { type: "text" },
            evidence: {
              type: "nested",
              dynamic: "strict",
              properties: { claim: { type: "text" }, sourceText: { type: "text", index: false } }
            },
            provider: { type: "keyword" },
            model: { type: "keyword" },
            promptVersion: { type: "keyword" },
            generatedAt: { type: "date" }
          }
        }
      });
    } catch (error) {
      if (!(error instanceof errors.ResponseError && error.statusCode === 400 && error.message.includes("resource_already_exists_exception"))) throw error;
    }
  })();
  return indexReady;
}

function jsonFromModel(value: string): unknown {
  const withoutFences = value.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/i, "").trim();
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start < 0 || end <= start) throw new AiProfileError("AI_INVALID_RESPONSE", "Nemotron returned no JSON job profile.", 502);
  try {
    return JSON.parse(withoutFences.slice(start, end + 1));
  } catch {
    throw new AiProfileError("AI_INVALID_RESPONSE", "Nemotron returned an invalid JSON job profile.", 502);
  }
}

function sourceMaterial(job: CanonicalJob): string {
  return [job.title, job.companyName, job.location, job.description, job.requirements, ...job.skills]
    .filter(Boolean)
    .join("\n")
    .slice(0, 18_000);
}

function promptFor(job: CanonicalJob): string {
  return `You create concise dating-app-style job profiles from supplied source text. Return JSON only with exactly these keys: oneLiner (string), mission (string), highlights (2-5 strings), mustHaveSkills (0-10 strings), whyYouMightLoveIt (string), interviewSignals (0-6 strings), evidence (0-10 objects with claim and an exact short sourceText quote). Never invent salary, location, work mode, sponsorship, requirements, or benefits. Every evidence sourceText must appear verbatim in SOURCE.\n\nSOURCE\n${sourceMaterial(job)}`;
}

function validateEvidence(profile: z.infer<typeof jobProfileSchema>, job: CanonicalJob) {
  const source = sourceMaterial(job).toLocaleLowerCase("en-US");
  return {
    ...profile,
    evidence: profile.evidence.filter((item) => source.includes(item.sourceText.toLocaleLowerCase("en-US")))
  };
}

export async function getJobProfile(jobId: string): Promise<{ profile: JobProfile; cached: boolean }> {
  const client = getElasticClient();
  let job: CanonicalJob;
  try {
    const result = await client.get<CanonicalJob>({ index: config.jobsAlias, id: jobId });
    job = result._source as CanonicalJob;
  } catch (error) {
    if (error instanceof errors.ResponseError && error.statusCode === 404) {
      throw new AiProfileError("JOB_NOT_FOUND", "The indexed job was not found.", 404);
    }
    throw error;
  }

  await ensureProfileIndex();
  try {
    const cached = await client.get<JobProfile>({ index: config.jobProfilesIndex, id: jobId });
    if (cached._source?.sourceContentHash === job.contentHash) return { profile: cached._source, cached: true };
  } catch (error) {
    if (!(error instanceof errors.ResponseError && error.statusCode === 404)) throw error;
  }

  const response = await client.inference.completion({
    inference_id: config.ELASTIC_NVIDIA_INFERENCE_ID,
    input: promptFor(job),
    timeout: "60s"
  });
  const output = response.completion[0]?.result;
  if (!output) throw new AiProfileError("AI_EMPTY_RESPONSE", "Nemotron returned an empty job profile.", 502);
  const parsed = validateEvidence(jobProfileSchema.parse(jsonFromModel(output)), job);
  const profile: JobProfile = {
    ...parsed,
    jobId,
    sourceContentHash: job.contentHash,
    provider: "elastic-nvidia",
    model: "nemotron",
    promptVersion: "workwink-job-profile-v1",
    generatedAt: new Date().toISOString()
  };
  await client.index({ index: config.jobProfilesIndex, id: jobId, document: profile, refresh: "wait_for" });
  return { profile, cached: false };
}

export async function integrationProof() {
  const client = getElasticClient();
  const [info, jobs, runs, profiles] = await Promise.all([
    client.info(),
    client.count({ index: config.jobsAlias }),
    client.search({ index: config.runsIndex, size: 1, sort: [{ finishedAt: "desc" }], _source: true }),
    client.indices.exists({ index: config.jobProfilesIndex }).then((exists) => exists ? client.count({ index: config.jobProfilesIndex }) : { count: 0 })
  ]);
  return {
    apify: {
      actorId: "apify/web-scraper",
      actorUrl: "https://console.apify.com/actors/moJRLRc85AitArpNN",
      cadence: "0 */6 * * * (UTC)",
      scheduleId: config.APIFY_SCHEDULE_ID ?? null
    },
    elastic: {
      cluster: info.cluster_name,
      version: info.version.number,
      jobsReadAlias: config.jobsAlias,
      jobsWriteAlias: config.jobsWriteAlias,
      jobsIndex: `${config.ELASTICSEARCH_INDEX_PREFIX}-jobs-v1`,
      ingestionRunsIndex: config.runsIndex,
      aiProfilesIndex: config.jobProfilesIndex,
      jobDocuments: jobs.count,
      aiProfiles: profiles.count,
      latestIngestion: runs.hits.hits[0]?._source ?? null
    },
    ai: {
      inferenceId: config.ELASTIC_NVIDIA_INFERENCE_ID,
      provider: "Elastic native NVIDIA inference",
      model: "NVIDIA Nemotron",
      authoritativeFieldsRemainDeterministic: true
    },
    generatedAt: new Date().toISOString()
  };
}
