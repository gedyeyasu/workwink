import { createHash } from "node:crypto";
import { decodeHTML } from "entities";
import sanitizeHtml from "sanitize-html";
import { canonicalJobSchema, type CanonicalJob } from "../contracts/job.js";

type UnknownRecord = Record<string, unknown>;

const SKILLS = [
  "AWS", "Azure", "C#", "C++", "Docker", "Elasticsearch", "GCP", "Go", "GraphQL", "Java", "JavaScript",
  "Kotlin", "Kubernetes", "LLM", "Machine Learning", "Node.js", "PostgreSQL", "Python", "React", "Redis",
  "Ruby", "Rust", "SQL", "Swift", "Terraform", "TypeScript"
] as const;

export class NormalizationError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

export function normalizeApifyJob(rawValue: unknown, sourceRunId: string, now = new Date()): CanonicalJob {
  const envelope = asRecord(rawValue);
  const posting = asRecord(envelope.jobPosting ?? envelope.job ?? envelope);
  const sourceUrl = firstUrl(envelope.sourceUrl, envelope.url, posting.url, posting.sameAs);
  const applyUrl = firstUrl(envelope.applyUrl, posting.url, sourceUrl);
  if (!sourceUrl || !applyUrl) throw new NormalizationError("Job is missing a valid source or application URL.", "missing_url");

  const title = firstText(posting.title, envelope.title);
  const organization = asRecord(posting.hiringOrganization ?? envelope.hiringOrganization);
  const companyName = firstText(organization.name, envelope.companyName, envelope.company);
  const description = cleanText(firstText(posting.description, envelope.description, envelope.text));
  if (!title || !companyName || !description) {
    throw new NormalizationError("Job requires title, company, and description.", "missing_core_fields");
  }

  const location = extractLocation(posting, envelope);
  const sourceJobId = extractIdentifier(posting.identifier ?? envelope.identifier ?? envelope.jobId);
  const employmentType = uniqueStrings(posting.employmentType ?? envelope.employmentType);
  const industries = uniqueStrings(posting.industry ?? envelope.industry);
  const workMode = inferWorkMode(posting, description, location);
  const locationCountry = extractCountry(posting);
  const structuredSalary = normalizeSalary(posting.baseSalary ?? envelope.baseSalary ?? envelope.salary);
  const salary = structuredSalary.annualMin !== null || structuredSalary.annualMax !== null
    ? structuredSalary
    : extractDisclosedSalary(description, { location, locationCountry });
  const postedAt = isoDate(posting.datePosted ?? envelope.datePosted ?? envelope.postedAt);
  const validThrough = isoDate(posting.validThrough ?? envelope.validThrough);
  const collectedAt = isoDate(envelope.scrapedAt ?? envelope.collectedAt) ?? now.toISOString();
  const requirements = cleanText(firstText(posting.qualifications, posting.experienceRequirements, envelope.requirements));
  const skills = extractSkills(`${title}\n${description}\n${requirements}`);
  const seniority = inferSeniority(title);
  const titleFamily = inferTitleFamily(title);
  const status = inferStatus(envelope, posting, validThrough, now);
  const companyWebsite = firstUrl(organization.sameAs, organization.url, envelope.companyWebsite);

  const identitySeed = sourceJobId ? `${hostname(sourceUrl)}:${sourceJobId}` : `${companyName}|${title}|${location}|${applyUrl}`.toLowerCase();
  const jobId = createHash("sha256").update(identitySeed).digest("hex").slice(0, 32);
  const searchText = [title, companyName, titleFamily, seniority, location, workMode, employmentType.join(" "), skills.join(" "), requirements, description].filter(Boolean).join("\n");
  const contentHash = createHash("sha256").update(JSON.stringify({ title, companyName, location, workMode, employmentType, description, requirements, salary, postedAt, validThrough, applyUrl })).digest("hex");

  return canonicalJobSchema.parse({
    jobId, source: hostname(sourceUrl), sourceJobId, sourceRunId, sourceUrl, applyUrl, title, titleFamily, seniority,
    companyName, companyWebsite, location, locationCountry, workMode, employmentType, industries, skills, description,
    requirements, salary, postedAt, validThrough, collectedAt, verifiedAt: now.toISOString(), status, contentHash,
    schemaVersion: 1, searchText
  });
}

type SalaryContext = { location: string; locationCountry: string | null };

/**
 * Extracts only an employer-disclosed USD range from the job description.
 * This is deliberately conservative: single numbers, equity grants, bonuses,
 * ranges without a pay period, and non-US dollar ranges remain unknown.
 */
export function extractDisclosedSalary(
  description: string,
  context: SalaryContext
): CanonicalJob["salary"] {
  const unknown = normalizeSalary(undefined);
  const isUsListing = context.locationCountry?.toUpperCase() === "US"
    || /\b(?:california|united states|u\.s\.|usa)\b|,\s*CA\b/i.test(context.location);
  const rangePattern = /(?:\b(?:USD|US)\s*)?\$\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*[kK])\s*(?:-|–|—|\bto\b)\s*(?:\b(?:USD|US)\s*)?\$?\s*(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?\s*[kK])(?:\s*\bUSD\b)?/gi;
  const candidates: Array<CanonicalJob["salary"] & { score: number; offset: number }> = [];

  for (const match of description.matchAll(rangePattern)) {
    const min = disclosedAmount(match[1]);
    const max = disclosedAmount(match[2]);
    if (min === null || max === null || max < min || max > 10_000_000) continue;

    const offset = match.index ?? 0;
    const leadingContext = description.slice(Math.max(0, offset - 140), offset);
    const nearby = description.slice(Math.max(0, offset - 180), Math.min(description.length, offset + match[0].length + 120));
    const period = disclosedPeriod(nearby, min, max);
    if (!period) continue;

    const explicitlyUsd = /\bUSD\b|\bUS\s*\$/i.test(match[0]) || /\bUSD\b|\bUS base (?:salary|pay)\b/i.test(nearby);
    if (!explicitlyUsd && !isUsListing) continue;
    if (period === "year" && min < 10_000) continue;
    if (period === "hour" && max > 1_000) continue;

    const multiplier = period === "hour" ? 2_080 : 1;
    const locationScore = /\b(?:california|san francisco|bay area|los angeles|san jose|san diego)\b|,\s*CA\b/i.test(leadingContext) ? 4 : 0;
    const disclosureScore = /\b(?:base salary|salary range|base pay|compensation range)\b/i.test(nearby) ? 2 : 0;
    candidates.push({
      min,
      max,
      currency: "USD",
      period,
      annualMin: Math.round(min * multiplier),
      annualMax: Math.round(max * multiplier),
      sourceText: match[0].trim(),
      score: locationScore + disclosureScore + (explicitlyUsd ? 1 : 0),
      offset
    });
  }

  const best = candidates.sort((left, right) => right.score - left.score || left.offset - right.offset)[0];
  if (!best) return unknown;
  return {
    min: best.min,
    max: best.max,
    currency: best.currency,
    period: best.period,
    annualMin: best.annualMin,
    annualMax: best.annualMax,
    sourceText: best.sourceText
  };
}

function disclosedAmount(value: string | undefined): number | null {
  if (!value) return null;
  const normalized = value.replace(/,/g, "").replace(/\s+/g, "");
  const multiplier = /k$/i.test(normalized) ? 1_000 : 1;
  const parsed = Number(normalized.replace(/k$/i, ""));
  return Number.isFinite(parsed) && parsed >= 0 ? parsed * multiplier : null;
}

function disclosedPeriod(nearby: string, min: number, max: number): "hour" | "year" | null {
  if (/\b(?:hourly|per hour|an hour)\b|\/\s*(?:hr|hour)\b/i.test(nearby)) return "hour";
  if (/\b(?:annual|annually|yearly|per year|base salary|salary range)\b|\/\s*(?:yr|year)\b/i.test(nearby)) return "year";
  if (/\b(?:base pay|compensation range)\b/i.test(nearby) && min >= 10_000 && max >= 10_000) return "year";
  return null;
}

function normalizeSalary(value: unknown): CanonicalJob["salary"] {
  const salary = asRecord(value);
  const inner = asRecord(salary.value ?? salary);
  const min = numberOrNull(inner.minValue ?? inner.min ?? salary.minValue ?? salary.min);
  const max = numberOrNull(inner.maxValue ?? inner.max ?? salary.maxValue ?? salary.max ?? min);
  const period = normalizePeriod(firstText(inner.unitText, salary.unitText, salary.period));
  const multiplier = { hour: 2080, day: 260, week: 52, month: 12, year: 1, unknown: 1 }[period];
  return {
    min, max, currency: normalizeCurrency(firstText(salary.currency, inner.currency)), period,
    annualMin: min === null ? null : Math.round(min * multiplier),
    annualMax: max === null ? null : Math.round(max * multiplier),
    sourceText: firstText(salary.sourceText, salary.text) || null
  };
}

function inferStatus(envelope: UnknownRecord, posting: UnknownRecord, validThrough: string | null, now: Date): CanonicalJob["status"] {
  if (envelope.expired === true || posting.expired === true) return "closed";
  if (validThrough && new Date(validThrough) < now) return "closed";
  return "active";
}

function inferWorkMode(posting: UnknownRecord, description: string, location: string): CanonicalJob["workMode"] {
  const marker = `${firstText(posting.jobLocationType)} ${description.slice(0, 3000)} ${location}`.toLowerCase();
  if (/telecommute|remote/.test(marker)) return "remote";
  if (/hybrid/.test(marker)) return "hybrid";
  return location === "Location not specified" ? "unknown" : "onsite";
}

function inferSeniority(title: string) {
  const value = title.toLowerCase();
  if (/\b(intern|internship)\b/.test(value)) return "Intern";
  if (/\b(junior|jr\.?|entry)\b/.test(value)) return "Entry";
  if (/\b(principal|distinguished|fellow)\b/.test(value)) return "Principal";
  if (/\b(staff)\b/.test(value)) return "Staff";
  if (/\b(senior|sr\.?)\b/.test(value)) return "Senior";
  if (/\b(lead|manager|director|head|vp|vice president)\b/.test(value)) return "Leadership";
  return "Mid-level";
}

function inferTitleFamily(title: string) {
  const value = title.toLowerCase();
  if (/platform|infrastructure|site reliability|sre|devops/.test(value)) return "Platform & Infrastructure";
  if (/data|analytics|machine learning|ml|ai /.test(value)) return "Data & AI";
  if (/security/.test(value)) return "Security";
  if (/mobile|ios|android/.test(value)) return "Mobile";
  if (/product manager|product lead/.test(value)) return "Product";
  if (/design|designer/.test(value)) return "Design";
  if (/engineer|developer|software/.test(value)) return "Software Engineering";
  return "Other";
}

function extractSkills(text: string) {
  return SKILLS.filter((skill) => new RegExp(`(^|[^a-z0-9+#])${escapeRegExp(skill.toLowerCase())}([^a-z0-9+#]|$)`, "i").test(text));
}

function extractLocation(posting: UnknownRecord, envelope: UnknownRecord) {
  const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
  for (const value of locations) {
    const place = asRecord(value); const address = asRecord(place.address ?? value);
    const text = [address.addressLocality, address.addressRegion, address.addressCountry]
      .map((value) => firstText(value))
      .filter(Boolean)
      .join(", ");
    if (text) return text;
  }
  return firstText(envelope.location, posting.jobLocationType) || "Location not specified";
}

function extractCountry(posting: UnknownRecord) {
  const value = Array.isArray(posting.jobLocation) ? posting.jobLocation[0] : posting.jobLocation;
  const address = asRecord(asRecord(value).address ?? value);
  const country = address.addressCountry;
  return typeof country === "string" ? country : firstText(asRecord(country).name) || null;
}

function extractIdentifier(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") return String(value);
  const record = asRecord(value);
  return firstText(record.value, record.name) || null;
}

function normalizePeriod(value: string): CanonicalJob["salary"]["period"] {
  const normalized = value.toLowerCase();
  if (/hour/.test(normalized)) return "hour"; if (/day/.test(normalized)) return "day";
  if (/week/.test(normalized)) return "week"; if (/month/.test(normalized)) return "month";
  if (/year|annual/.test(normalized)) return "year"; return "unknown";
}

function normalizeCurrency(value: string) { const code = value.trim().toUpperCase(); return /^[A-Z]{3}$/.test(code) ? code : null; }
function isoDate(value: unknown) { if (!value) return null; const date = new Date(String(value)); return Number.isNaN(date.valueOf()) ? null : date.toISOString(); }
function numberOrNull(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}
function cleanText(value: string) {
  // Greenhouse's API can return an HTML fragment whose tags and entities are
  // encoded one extra time. Decode at most two layers, then strip all markup.
  // The bounded passes handle `&lt;span&gt;...&amp;mdash;...` without recursively
  // expanding attacker-controlled entity text.
  const decoded = decodeHTML(decodeHTML(value));
  return sanitizeHtml(decoded, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
function firstUrl(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value !== "string") continue;
    try { return new URL(value).toString(); } catch { /* continue */ }
  }
  return null;
}
function firstText(...values: unknown[]): string { for (const value of values.flat()) if (typeof value === "string" && value.trim()) return value.trim(); return ""; }
function uniqueStrings(value: unknown) { const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,|]/) : []; return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]; }
function asRecord(value: unknown): UnknownRecord { return value && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : {}; }
function hostname(value: string) { return new URL(value).hostname.replace(/^www\./, ""); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
