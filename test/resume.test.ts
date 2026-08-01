import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { parseResumePdf, ResumeParseError } from "../src/domain/resume.js";
import { resumeRoutes } from "../src/routes/resume.js";

function createTextPdf(text: string): Buffer {
  const escapedText = text.replace(/([\\()])/g, "\\$1");
  const content = `BT /F1 11 Tf 54 720 Td (${escapedText}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];

  let pdf = "%PDF-1.4\n%workwink\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf);
}

function multipartBody(pdf: Buffer, preferences?: Record<string, unknown>): { body: Buffer; contentType: string } {
  const boundary = "----workwink-resume-test-boundary";
  const chunks: Buffer[] = [];
  if (preferences) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="preferences"\r\n\r\n${JSON.stringify(preferences)}\r\n`
    ));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="resume"; filename="resume.pdf"\r\nContent-Type: application/pdf\r\n\r\n`
  ));
  chunks.push(pdf);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

const resumeText = "Senior Software Engineer with 8 years of experience. TypeScript React Node.js PostgreSQL AWS Docker Kubernetes Elasticsearch";

describe("resume PDF parsing", () => {
  it("extracts a deterministic, evidence-backed profile from real PDF text", async () => {
    const profile = await parseResumePdf(createTextPdf(resumeText));

    expect(profile.extraction).toMatchObject({
      pageCount: 1,
      parser: "pdfjs",
      rawResumeStored: false
    });
    expect(profile.extraction.extractedCharacters).toBeGreaterThan(80);
    expect(profile.skills.map((skill) => skill.name)).toEqual([
      "TypeScript", "React", "Node.js", "PostgreSQL", "AWS", "Docker"
    ]);
    expect(profile.yearsExperience?.value).toBe(8);
    expect(profile.preferences.location).toMatchObject({ city: "Austin", region: "Texas", source: "demo_default" });
    expect(profile.preferences.workModes).toEqual({ values: ["remote", "hybrid"], source: "demo_default" });

    const typescript = profile.skills.find((skill) => skill.name === "TypeScript");
    expect(typescript?.evidence.matchedText).toBe("TypeScript");
    expect(typescript?.evidence.context.slice(
      typescript.evidence.start - typescript.evidence.contextStart,
      typescript.evidence.end - typescript.evidence.contextStart
    )).toBe("TypeScript");
  });

  it("keeps supplied search preferences separate from resume-derived facts", async () => {
    const profile = await parseResumePdf(createTextPdf(resumeText), {
      targetRoles: ["Staff Software Engineer"],
      location: { city: "Austin", region: "Texas", radiusMiles: 25 },
      workModes: ["remote", "hybrid"]
    });

    expect(profile.targetRoles).toEqual({
      values: ["Staff Software Engineer"],
      source: "user_preference",
      evidence: []
    });
    expect(profile.preferences.location.source).toBe("user_preference");
    expect(profile.skills.length).toBeGreaterThan(0);
  });

  it("fails closed for invalid and empty PDF input", async () => {
    await expect(parseResumePdf(Buffer.from("not a pdf"))).rejects.toMatchObject({
      code: "RESUME_INVALID_PDF",
      statusCode: 415
    } satisfies Partial<ResumeParseError>);
    await expect(parseResumePdf(Buffer.alloc(0))).rejects.toMatchObject({ code: "RESUME_SIZE_INVALID" });
  });
});

describe("resume upload route", () => {
  it("accepts one bounded PDF and returns no-store structured data", async () => {
    const app = Fastify();
    await app.register(multipart, {
      limits: { fileSize: 5 * 1_024 * 1_024, files: 1, fields: 1, parts: 2 }
    });
    await app.register(resumeRoutes);
    const upload = multipartBody(createTextPdf(resumeText), {
      targetRoles: ["Software Engineer"],
      location: { city: "Austin", region: "Texas", radiusMiles: 50 },
      workModes: ["remote", "hybrid"]
    });

    const response = await app.inject({
      method: "POST",
      url: "/profile/resume",
      headers: { "content-type": upload.contentType },
      payload: upload.body
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.json().profile.skills.length).toBeGreaterThan(0);
    expect(JSON.stringify(response.json())).not.toContain(resumeText);
    await app.close();
  });

  it("rejects non-multipart requests", async () => {
    const app = Fastify();
    await app.register(multipart);
    await app.register(resumeRoutes);
    const response = await app.inject({ method: "POST", url: "/profile/resume", payload: {} });
    expect(response.statusCode).toBe(415);
    await app.close();
  });
});
