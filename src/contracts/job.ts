import { z } from "zod";

export const workModeSchema = z.enum(["remote", "hybrid", "onsite", "unknown"]);
export const lifecycleSchema = z.enum(["active", "stale", "closed"]);

export const salarySchema = z.object({
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
  currency: z.string().length(3).nullable(),
  period: z.enum(["hour", "day", "week", "month", "year", "unknown"]),
  annualMin: z.number().nonnegative().nullable(),
  annualMax: z.number().nonnegative().nullable(),
  sourceText: z.string().nullable()
});

export const canonicalJobSchema = z.object({
  jobId: z.string().min(8),
  source: z.string().min(1),
  sourceJobId: z.string().nullable(),
  sourceRunId: z.string().min(1),
  sourceUrl: z.string().url(),
  applyUrl: z.string().url(),
  title: z.string().min(1),
  titleFamily: z.string().min(1),
  seniority: z.string().min(1),
  companyName: z.string().min(1),
  companyWebsite: z.string().url().nullable(),
  location: z.string().min(1),
  locationCountry: z.string().nullable(),
  workMode: workModeSchema,
  employmentType: z.array(z.string()),
  industries: z.array(z.string()),
  skills: z.array(z.string()),
  description: z.string().min(1),
  requirements: z.string(),
  salary: salarySchema,
  postedAt: z.string().datetime().nullable(),
  validThrough: z.string().datetime().nullable(),
  collectedAt: z.string().datetime(),
  verifiedAt: z.string().datetime(),
  status: lifecycleSchema,
  contentHash: z.string().length(64),
  schemaVersion: z.literal(1),
  searchText: z.string().min(1)
});

export type CanonicalJob = z.infer<typeof canonicalJobSchema>;

export const searchRequestSchema = z.object({
  query: z.string().trim().max(500).default(""),
  filters: z.object({
    workModes: z.array(workModeSchema.exclude(["unknown"])).max(3).default([]),
    seniority: z.array(z.string().min(1).max(80)).max(20).default([]),
    titleFamilies: z.array(z.string().min(1).max(120)).max(20).default([]),
    skills: z.array(z.string().min(1).max(80)).max(30).default([]),
    companies: z.array(z.string().min(1).max(160)).max(50).default([]),
    employmentTypes: z.array(z.string().min(1).max(80)).max(20).default([]),
    industries: z.array(z.string().min(1).max(120)).max(20).default([]),
    minimumSalary: z.number().int().nonnegative().max(10_000_000).nullable().default(null),
    includeUnknownSalary: z.boolean().default(true),
    postedWithinDays: z.number().int().min(1).max(365).nullable().default(30)
  }).default({
    workModes: [], seniority: [], titleFamilies: [], skills: [], companies: [], employmentTypes: [], industries: [],
    minimumSalary: null, includeUnknownSalary: true, postedWithinDays: 30
  }),
  sort: z.enum(["relevance", "newest", "salary"]).default("relevance"),
  pageSize: z.number().int().min(1).max(50).default(20),
  cursor: z.string().max(4096).nullable().default(null)
});

export type SearchRequest = z.infer<typeof searchRequestSchema>;

export type FacetBucket = { value: string; count: number };
export type JobFacets = Record<"workModes" | "seniority" | "titleFamilies" | "skills" | "companies" | "employmentTypes" | "industries", FacetBucket[]>;

export type SearchResponse = {
  items: Array<CanonicalJob & { score: number | null; highlights: string[] }>;
  total: number;
  facets: JobFacets;
  nextCursor: string | null;
  mode: "lexical" | "hybrid";
  degraded: boolean;
  dataFreshness: string | null;
  tookMs: number;
};

export const apifyWebhookSchema = z.object({
  eventType: z.string().optional(),
  eventData: z.object({ actorId: z.string().optional(), actorRunId: z.string().optional() }).passthrough().optional(),
  resource: z.object({ id: z.string(), actId: z.string().optional(), defaultDatasetId: z.string().optional(), status: z.string().optional() }).passthrough().optional()
}).passthrough();
