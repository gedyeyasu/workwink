import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { z } from "zod";

export const MAX_RESUME_BYTES = 5 * 1_024 * 1_024;
export const MAX_RESUME_PAGES = 12;
const MAX_EXTRACTED_CHARACTERS = 100_000;

export const workModeSchema = z.enum(["remote", "hybrid", "onsite"]);

export const resumePreferencesSchema = z.object({
  targetRoles: z.array(z.string().trim().min(2).max(80)).max(5).optional(),
  location: z.object({
    city: z.string().trim().min(2).max(80),
    region: z.string().trim().min(2).max(80).optional(),
    radiusMiles: z.number().int().min(0).max(500).default(50)
  }).optional(),
  workModes: z.array(workModeSchema).min(1).max(3).optional()
}).strict();

export type ResumePreferencesInput = z.infer<typeof resumePreferencesSchema>;

export type EvidenceSpan = {
  page: number;
  start: number;
  end: number;
  matchedText: string;
  contextStart: number;
  contextEnd: number;
  context: string;
};

export type ResumeSkill = {
  name: string;
  evidence: EvidenceSpan;
};

export type CandidateProfile = {
  schemaVersion: "1";
  profileSource: "resume_pdf";
  skills: ResumeSkill[];
  targetRoles: {
    values: string[];
    source: "user_preference" | "resume_inference";
    evidence: EvidenceSpan[];
  };
  preferences: {
    location: {
      city: string;
      region: string;
      radiusMiles: number;
      source: "user_preference" | "demo_default";
    };
    workModes: {
      values: Array<z.infer<typeof workModeSchema>>;
      source: "user_preference" | "demo_default";
    };
  };
  yearsExperience?: {
    value: number;
    evidence: EvidenceSpan;
  };
  professionalSummary: string;
  extraction: {
    pageCount: number;
    extractedCharacters: number;
    parser: "pdfjs";
    rawResumeStored: false;
  };
};

type ExtractedPage = {
  page: number;
  text: string;
};

type SkillDefinition = {
  name: string;
  aliases: string[];
};

const SKILL_DEFINITIONS: SkillDefinition[] = [
  { name: "Elasticsearch", aliases: ["elasticsearch", "elastic search"] },
  { name: "TypeScript", aliases: ["typescript"] },
  { name: "JavaScript", aliases: ["javascript"] },
  { name: "Node.js", aliases: ["node.js", "nodejs", "node"] },
  { name: "Next.js", aliases: ["next.js", "nextjs"] },
  { name: "React", aliases: ["react.js", "reactjs", "react"] },
  { name: "Python", aliases: ["python"] },
  { name: "Java", aliases: ["java"] },
  { name: "C#", aliases: ["c#", "c sharp"] },
  { name: "C++", aliases: ["c++"] },
  { name: ".NET", aliases: [".net", "dotnet"] },
  { name: "Go", aliases: ["golang", "go"] },
  { name: "Rust", aliases: ["rust"] },
  { name: "SQL", aliases: ["sql"] },
  { name: "PostgreSQL", aliases: ["postgresql", "postgres"] },
  { name: "MySQL", aliases: ["mysql"] },
  { name: "MongoDB", aliases: ["mongodb"] },
  { name: "Redis", aliases: ["redis"] },
  { name: "GraphQL", aliases: ["graphql"] },
  { name: "REST APIs", aliases: ["restful api", "rest api", "rest apis"] },
  { name: "Fastify", aliases: ["fastify"] },
  { name: "AWS", aliases: ["amazon web services", "aws"] },
  { name: "Azure", aliases: ["microsoft azure", "azure"] },
  { name: "Google Cloud", aliases: ["google cloud platform", "google cloud", "gcp"] },
  { name: "Docker", aliases: ["docker"] },
  { name: "Kubernetes", aliases: ["kubernetes", "k8s"] },
  { name: "Terraform", aliases: ["terraform"] },
  { name: "Apache Kafka", aliases: ["apache kafka", "kafka"] },
  { name: "Apache Spark", aliases: ["apache spark", "spark"] },
  { name: "GitHub Actions", aliases: ["github actions"] },
  { name: "Apify", aliases: ["apify"] }
];

const ROLE_SIGNALS: Array<{ role: string; skills: string[] }> = [
  { role: "Backend Software Engineer", skills: ["Node.js", "Python", "Java", "C#", ".NET", "Go", "Rust", "REST APIs", "GraphQL", "Fastify", "PostgreSQL", "MySQL", "MongoDB", "Redis", "Apache Kafka"] },
  { role: "Full Stack Software Engineer", skills: ["TypeScript", "JavaScript", "React", "Next.js", "Node.js", "REST APIs", "GraphQL", "PostgreSQL"] },
  { role: "Frontend Software Engineer", skills: ["TypeScript", "JavaScript", "React", "Next.js"] },
  { role: "Cloud Platform Engineer", skills: ["AWS", "Azure", "Google Cloud", "Docker", "Kubernetes", "Terraform", "GitHub Actions"] },
  { role: "Data Engineer", skills: ["Python", "SQL", "PostgreSQL", "Apache Kafka", "Apache Spark"] },
  { role: "Search Engineer", skills: ["Elasticsearch", "Python", "Java", "Node.js"] }
];

export class ResumeParseError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode = 422) {
    super(message);
    this.name = "ResumeParseError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeExtractedText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isTokenCharacter(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

function findAlias(page: ExtractedPage, aliases: string[]): EvidenceSpan | undefined {
  const haystack = page.text.toLocaleLowerCase("en-US");
  for (const alias of [...aliases].sort((left, right) => right.length - left.length)) {
    const needle = alias.toLocaleLowerCase("en-US");
    let fromIndex = 0;
    while (fromIndex < haystack.length) {
      const start = haystack.indexOf(needle, fromIndex);
      if (start < 0) break;
      const end = start + needle.length;
      if (!isTokenCharacter(haystack[start - 1]) && !isTokenCharacter(haystack[end])) {
        const contextStart = Math.max(0, start - 55);
        const contextEnd = Math.min(page.text.length, end + 55);
        return {
          page: page.page,
          start,
          end,
          matchedText: page.text.slice(start, end),
          contextStart,
          contextEnd,
          context: page.text.slice(contextStart, contextEnd)
        };
      }
      fromIndex = end;
    }
  }
  return undefined;
}

function extractSkills(pages: ExtractedPage[]): ResumeSkill[] {
  const skills: ResumeSkill[] = [];
  for (const definition of SKILL_DEFINITIONS) {
    for (const page of pages) {
      const evidence = findAlias(page, definition.aliases);
      if (evidence) {
        skills.push({ name: definition.name, evidence });
        break;
      }
    }
  }
  return skills.sort((left, right) =>
    left.evidence.page - right.evidence.page || left.evidence.start - right.evidence.start || left.name.localeCompare(right.name)
  );
}

function inferRoles(skills: ResumeSkill[]): { values: string[]; evidence: EvidenceSpan[] } {
  const byName = new Map(skills.map((skill) => [skill.name, skill]));
  const ranked = ROLE_SIGNALS
    .map((role, order) => ({
      ...role,
      order,
      matches: role.skills.flatMap((skill) => byName.get(skill) ?? [])
    }))
    .filter((role) => role.matches.length > 0)
    .sort((left, right) => right.matches.length - left.matches.length || left.order - right.order);

  const selected = ranked.slice(0, 3);
  if (selected.length === 0) return { values: ["Software Engineer"], evidence: [] };

  const evidence = new Map<string, EvidenceSpan>();
  for (const role of selected) {
    for (const match of role.matches.slice(0, 2)) {
      evidence.set(`${match.evidence.page}:${match.evidence.start}:${match.name}`, match.evidence);
    }
  }
  return { values: selected.map((role) => role.role), evidence: [...evidence.values()] };
}

function extractYearsExperience(pages: ExtractedPage[]): CandidateProfile["yearsExperience"] {
  const pattern = /\b(\d{1,2})\+?\s+years?(?:\s+of)?\s+(?:professional\s+)?experience\b/i;
  for (const page of pages) {
    const match = pattern.exec(page.text);
    if (!match || match.index === undefined || !match[1]) continue;
    const value = Number.parseInt(match[1], 10);
    if (value > 50) continue;
    const start = match.index;
    const end = start + match[0].length;
    const contextStart = Math.max(0, start - 55);
    const contextEnd = Math.min(page.text.length, end + 55);
    return {
      value,
      evidence: {
        page: page.page,
        start,
        end,
        matchedText: page.text.slice(start, end),
        contextStart,
        contextEnd,
        context: page.text.slice(contextStart, contextEnd)
      }
    };
  }
  return undefined;
}

function summarize(skills: ResumeSkill[], roles: string[]): string {
  const displayedSkills = skills.slice(0, 6).map((skill) => skill.name);
  const skillPhrase = displayedSkills.length > 0
    ? ` Evidence in the resume includes ${displayedSkills.join(", ")}.`
    : " No technology claims were inferred without direct resume evidence.";
  return `Candidate profile aligned to ${roles.join(", ")}.${skillPhrase}`;
}

export function buildCandidateProfile(pages: ExtractedPage[], input: ResumePreferencesInput = {}): CandidateProfile {
  const preferences = resumePreferencesSchema.parse(input);
  const skills = extractSkills(pages);
  const inferredRoles = inferRoles(skills);
  const targetRoles = preferences.targetRoles?.length ? preferences.targetRoles : inferredRoles.values;
  const yearsExperience = extractYearsExperience(pages);
  const extractedCharacters = pages.reduce((total, page) => total + page.text.length, 0);

  return {
    schemaVersion: "1",
    profileSource: "resume_pdf",
    skills,
    targetRoles: {
      values: targetRoles,
      source: preferences.targetRoles?.length ? "user_preference" : "resume_inference",
      evidence: preferences.targetRoles?.length ? [] : inferredRoles.evidence
    },
    preferences: {
      location: preferences.location
        ? { ...preferences.location, region: preferences.location.region ?? "Texas", source: "user_preference" }
        : { city: "Austin", region: "Texas", radiusMiles: 50, source: "demo_default" },
      workModes: preferences.workModes
        ? { values: preferences.workModes, source: "user_preference" }
        : { values: ["remote", "hybrid"], source: "demo_default" }
    },
    ...(yearsExperience ? { yearsExperience } : {}),
    professionalSummary: summarize(skills, targetRoles),
    extraction: {
      pageCount: pages.length,
      extractedCharacters,
      parser: "pdfjs",
      rawResumeStored: false
    }
  };
}

export async function parseResumePdf(buffer: Buffer, input: ResumePreferencesInput = {}): Promise<CandidateProfile> {
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_RESUME_BYTES) {
    throw new ResumeParseError("RESUME_SIZE_INVALID", `Resume PDF must be between 1 byte and ${MAX_RESUME_BYTES} bytes.`, 413);
  }
  if (buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new ResumeParseError("RESUME_INVALID_PDF", "The uploaded file is not a valid PDF.", 415);
  }

  let passwordRequested = false;
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true
  });
  loadingTask.onPassword = () => {
    passwordRequested = true;
    void loadingTask.destroy();
  };

  try {
    const document = await loadingTask.promise;
    if (document.numPages === 0 || document.numPages > MAX_RESUME_PAGES) {
      throw new ResumeParseError("RESUME_PAGE_LIMIT", `Resume PDF must contain between 1 and ${MAX_RESUME_PAGES} pages.`);
    }

    const pages: ExtractedPage[] = [];
    let extractedCharacters = 0;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = normalizeExtractedText(content.items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" "));
      extractedCharacters += text.length;
      if (extractedCharacters > MAX_EXTRACTED_CHARACTERS) {
        throw new ResumeParseError("RESUME_TEXT_LIMIT", "The resume contains too much extractable text.");
      }
      pages.push({ page: pageNumber, text });
      page.cleanup();
    }

    const nonWhitespaceCharacters = pages.reduce((total, page) => total + page.text.replace(/\s/g, "").length, 0);
    if (nonWhitespaceCharacters < 40) {
      throw new ResumeParseError(
        "RESUME_TEXT_EMPTY",
        "The PDF has no usable text. Upload a text-based, non-scanned resume PDF."
      );
    }

    return buildCandidateProfile(pages, input);
  } catch (error) {
    if (error instanceof ResumeParseError) throw error;
    const name = error instanceof Error ? error.name : "";
    if (passwordRequested || name === "PasswordException") {
      throw new ResumeParseError("RESUME_ENCRYPTED", "Encrypted or password-protected resume PDFs are not accepted.");
    }
    throw new ResumeParseError("RESUME_INVALID_PDF", "The PDF could not be safely parsed.");
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}
