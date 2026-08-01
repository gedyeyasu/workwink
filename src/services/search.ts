import { createHmac, timingSafeEqual } from "node:crypto";
import type { Client, estypes } from "@elastic/elasticsearch";
import {
  searchRequestSchema,
  type CanonicalJob,
  type JobFacets,
  type SearchRequest,
  type SearchResponse
} from "../contracts/job.js";
import { config } from "../config.js";
import { getElasticClient } from "../integrations/elastic.js";

type SearchMode = SearchResponse["mode"];
type FacetName = keyof JobFacets;
type FilterKey = keyof SearchRequest["filters"];
type Query = NonNullable<estypes.QueryDslQueryContainer>;

type CursorPayload = {
  v: 1;
  fingerprint: string;
  searchAfter: estypes.SortResults;
  mode: SearchMode;
  issuedAt: number;
};

export class InvalidSearchCursorError extends Error {
  readonly code = "INVALID_CURSOR";
  readonly statusCode = 400;

  constructor(message = "The search cursor is invalid or does not match this search.") {
    super(message);
    this.name = "InvalidSearchCursorError";
  }
}

const FACETS: Record<FacetName, { field: string; filterKey: FilterKey; size: number }> = {
  workModes: { field: "workMode", filterKey: "workModes", size: 10 },
  seniority: { field: "seniority", filterKey: "seniority", size: 20 },
  titleFamilies: { field: "titleFamily", filterKey: "titleFamilies", size: 20 },
  skills: { field: "skills", filterKey: "skills", size: 30 },
  companies: { field: "companyName.keyword", filterKey: "companies", size: 30 },
  employmentTypes: { field: "employmentType", filterKey: "employmentTypes", size: 20 },
  industries: { field: "industries", filterKey: "industries", size: 30 }
};

function termsFilter(field: string, values: readonly string[]): Query | undefined {
  return values.length > 0 ? { terms: { [field]: [...values] } } : undefined;
}

export function buildFilterContext(
  input: SearchRequest,
  omit?: FilterKey,
  now = new Date()
): Query[] {
  const filters: Array<Query | undefined> = [
    { term: { status: "active" } },
    omit === "workModes" ? undefined : termsFilter("workMode", input.filters.workModes),
    omit === "seniority" ? undefined : termsFilter("seniority", input.filters.seniority),
    omit === "titleFamilies" ? undefined : termsFilter("titleFamily", input.filters.titleFamilies),
    omit === "skills" ? undefined : termsFilter("skills", input.filters.skills),
    omit === "companies" ? undefined : termsFilter("companyName.keyword", input.filters.companies),
    omit === "employmentTypes" ? undefined : termsFilter("employmentType", input.filters.employmentTypes),
    omit === "industries" ? undefined : termsFilter("industries", input.filters.industries)
  ];

  if (omit !== "minimumSalary" && input.filters.minimumSalary !== null) {
    const salaryRange: Query = {
      range: { "salary.annualMax": { gte: input.filters.minimumSalary } }
    };
    filters.push(input.filters.includeUnknownSalary
      ? {
          bool: {
            minimum_should_match: 1,
            should: [salaryRange, { bool: { must_not: [{ exists: { field: "salary.annualMax" } }] } }]
          }
        }
      : salaryRange);
  }

  if (omit !== "postedWithinDays" && input.filters.postedWithinDays !== null) {
    const threshold = new Date(now.getTime() - input.filters.postedWithinDays * 86_400_000).toISOString();
    filters.push({ range: { postedAt: { gte: threshold } } });
  }

  return filters.filter((filter): filter is Query => filter !== undefined);
}

function lexicalClause(query: string): Query {
  if (!query) return { match_all: {} };
  return {
    bool: {
      should: [
        {
          multi_match: {
            query,
            fields: ["title^6", "titleFamily^4", "skills^4", "companyName^3", "location^3", "requirements^2", "description", "searchText"],
            type: "best_fields",
            operator: "and",
            fuzziness: "AUTO"
          }
        },
        { match_phrase: { title: { query, boost: 8 } } }
      ],
      minimum_should_match: 1
    }
  };
}

function searchQuery(input: SearchRequest, mode: SearchMode, now: Date): Query {
  const filter = buildFilterContext(input, undefined, now);
  if (!input.query) return { bool: { filter, must: [{ match_all: {} }] } };
  if (mode === "hybrid") {
    return {
      bool: {
        filter,
        should: [
          lexicalClause(input.query),
          { semantic: { field: "semanticText", query: input.query, boost: 1.5 } }
        ],
        minimum_should_match: 1
      }
    };
  }
  return { bool: { filter, must: [lexicalClause(input.query)] } };
}

function searchSort(input: SearchRequest): estypes.Sort {
  if (input.sort === "newest" || (input.sort === "relevance" && !input.query)) {
    return [{ postedAt: { order: "desc", missing: "_last" } }, { jobId: "asc" }];
  }
  if (input.sort === "salary") {
    return [
      { "salary.annualMax": { order: "desc", missing: "_last" } },
      { postedAt: { order: "desc", missing: "_last" } },
      { jobId: "asc" }
    ];
  }
  return ["_score", { postedAt: { order: "desc", missing: "_last" } }, { jobId: "asc" }];
}

function aggregations(input: SearchRequest, now: Date): Record<string, estypes.AggregationsAggregationContainer> {
  const result: Record<string, estypes.AggregationsAggregationContainer> = {
    freshness: { max: { field: "collectedAt" } }
  };
  for (const [name, facet] of Object.entries(FACETS) as Array<[FacetName, (typeof FACETS)[FacetName]]>) {
    result[name] = {
      global: {},
      aggs: {
        filtered: {
          filter: { bool: { filter: buildFilterContext(input, facet.filterKey, now) } },
          aggs: { values: { terms: { field: facet.field, size: facet.size } } }
        }
      }
    };
  }
  return result;
}

export function buildElasticSearchRequest(
  input: SearchRequest,
  mode: SearchMode,
  searchAfter?: estypes.SortResults,
  now = new Date()
): estypes.SearchRequest {
  return {
    index: config.jobsAlias,
    size: input.pageSize,
    track_total_hits: true,
    allow_partial_search_results: false,
    query: searchQuery(input, mode, now),
    sort: searchSort(input),
    ...(searchAfter ? { search_after: searchAfter } : {}),
    _source: { excludes: ["semanticText"] },
    highlight: {
      pre_tags: ["<mark>"],
      post_tags: ["</mark>"],
      number_of_fragments: 2,
      fragment_size: 180,
      fields: {
        title: { number_of_fragments: 0 },
        description: {},
        requirements: {}
      }
    },
    aggs: aggregations(input, now)
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, stableValue(child)]));
}

function fingerprint(input: SearchRequest): string {
  const cursorless = { ...input, cursor: null };
  return createHmac("sha256", cursorSecret()).update(JSON.stringify(stableValue(cursorless))).digest("base64url");
}

function cursorSecret(): string {
  const secret = config.CURSOR_SECRET ?? config.elasticApiKey;
  if (!secret) throw new Error("CURSOR_SECRET or an Elasticsearch API key is required for cursor signing.");
  return secret;
}

export function encodeSearchCursor(payload: CursorPayload): string {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", cursorSecret()).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
}

export function decodeSearchCursor(cursor: string, input: SearchRequest): CursorPayload {
  try {
    const parts = cursor.split(".");
    if (parts.length !== 2) throw new Error("malformed");
    const [encoded, suppliedSignature] = parts;
    if (!encoded || !suppliedSignature) throw new Error("malformed");
    const expectedSignature = createHmac("sha256", cursorSecret()).update(encoded).digest();
    const supplied = Buffer.from(suppliedSignature, "base64url");
    if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) throw new Error("signature");
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (payload.v !== 1 || !Array.isArray(payload.searchAfter) || (payload.mode !== "lexical" && payload.mode !== "hybrid")) {
      throw new Error("payload");
    }
    if (typeof payload.issuedAt !== "number" || Date.now() - payload.issuedAt > 86_400_000 || payload.issuedAt > Date.now() + 60_000) {
      throw new Error("expired");
    }
    if (payload.fingerprint !== fingerprint(input)) throw new Error("fingerprint");
    return payload as CursorPayload;
  } catch (error) {
    if (error instanceof InvalidSearchCursorError) throw error;
    throw new InvalidSearchCursorError();
  }
}

function totalHits(total: estypes.SearchTotalHits | number | undefined): number {
  return typeof total === "number" ? total : total?.value ?? 0;
}

type RawAggregations = Record<string, any>;

function parseFacets(raw: RawAggregations | undefined): JobFacets {
  const facets = {} as JobFacets;
  for (const name of Object.keys(FACETS) as FacetName[]) {
    const buckets = raw?.[name]?.filtered?.values?.buckets;
    facets[name] = Array.isArray(buckets)
      ? buckets.map((bucket: { key: string | number; doc_count: number }) => ({ value: String(bucket.key), count: bucket.doc_count }))
      : [];
  }
  return facets;
}

function highlights(hit: estypes.SearchHit<CanonicalJob>): string[] {
  return Object.values(hit.highlight ?? {}).flatMap((fragments) => fragments ?? []);
}

async function runSearch(
  client: Client,
  input: SearchRequest,
  mode: SearchMode,
  searchAfter: estypes.SortResults | undefined,
  now: Date
): Promise<SearchResponse> {
  const response = await client.search<CanonicalJob>(buildElasticSearchRequest(input, mode, searchAfter, now));
  const hits = response.hits.hits;
  const lastSort = hits.at(-1)?.sort;
  const nextCursor = hits.length === input.pageSize && lastSort
    ? encodeSearchCursor({ v: 1, fingerprint: fingerprint(input), searchAfter: lastSort, mode, issuedAt: Date.now() })
    : null;
  const rawAggregations = response.aggregations as RawAggregations | undefined;
  const freshness = rawAggregations?.freshness;

  return {
    items: hits.flatMap((hit) => hit._source
      ? [{ ...hit._source, score: hit._score ?? null, highlights: highlights(hit) }]
      : []),
    total: totalHits(response.hits.total),
    facets: parseFacets(rawAggregations),
    nextCursor,
    mode,
    degraded: false,
    dataFreshness: typeof freshness?.value_as_string === "string" ? freshness.value_as_string : null,
    tookMs: response.took
  };
}

export async function searchJobs(rawInput: SearchRequest, client = getElasticClient()): Promise<SearchResponse> {
  const input = searchRequestSchema.parse(rawInput);
  const requestedMode: SearchMode = config.ELASTIC_SEARCH_MODE;
  const cursorPayload = input.cursor ? decodeSearchCursor(input.cursor, input) : undefined;
  const mode = cursorPayload?.mode ?? requestedMode;
  const now = new Date();

  try {
    return await runSearch(client, input, mode, cursorPayload?.searchAfter, now);
  } catch (error) {
    if (mode !== "hybrid") throw error;
    const fallback = await runSearch(client, input, "lexical", undefined, now);
    return { ...fallback, degraded: true };
  }
}
