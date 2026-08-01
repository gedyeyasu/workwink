import type { FastifyPluginAsync } from "fastify";
import {
  MAX_RESUME_BYTES,
  parseResumePdf,
  resumePreferencesSchema,
  type ResumePreferencesInput
} from "../domain/resume.js";

class ResumeUploadError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(code: string, message: string, statusCode: number) {
    super(message);
    this.name = "ResumeUploadError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export const resumeRoutes: FastifyPluginAsync = async (app) => {
  app.post("/profile/resume", {
    bodyLimit: MAX_RESUME_BYTES + 64 * 1_024,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: "1 minute"
      }
    }
  }, async (request, reply) => {
    if (!request.isMultipart()) {
      throw new ResumeUploadError("MULTIPART_REQUIRED", "Upload the resume as multipart/form-data.", 415);
    }

    let resume: Buffer | undefined;
    let preferences: ResumePreferencesInput = {};
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (part.fieldname !== "resume") {
          part.file.resume();
          throw new ResumeUploadError("UNEXPECTED_FILE", "Only the resume file field is accepted.", 400);
        }
        if (resume) {
          part.file.resume();
          throw new ResumeUploadError("TOO_MANY_FILES", "Upload exactly one resume PDF.", 400);
        }
        if (part.mimetype.toLocaleLowerCase("en-US") !== "application/pdf" || !part.filename.toLocaleLowerCase("en-US").endsWith(".pdf")) {
          part.file.resume();
          throw new ResumeUploadError("PDF_REQUIRED", "The resume must be an application/pdf file with a .pdf filename.", 415);
        }
        resume = await part.toBuffer();
        if (part.file.truncated || resume.byteLength > MAX_RESUME_BYTES) {
          throw new ResumeUploadError("RESUME_TOO_LARGE", `Resume PDF cannot exceed ${MAX_RESUME_BYTES} bytes.`, 413);
        }
        continue;
      }

      if (part.fieldname !== "preferences") {
        throw new ResumeUploadError("UNEXPECTED_FIELD", "Only the optional preferences field is accepted.", 400);
      }
      if (typeof part.value !== "string") {
        throw new ResumeUploadError("PREFERENCES_INVALID", "Preferences must be a JSON string.", 400);
      }
      try {
        preferences = resumePreferencesSchema.parse(JSON.parse(part.value));
      } catch {
        throw new ResumeUploadError("PREFERENCES_INVALID", "Preferences must match the supported JSON schema.", 400);
      }
    }

    if (!resume) {
      throw new ResumeUploadError("RESUME_REQUIRED", "A resume PDF is required.", 400);
    }

    try {
      const profile = await parseResumePdf(resume, preferences);
      return reply
        .header("cache-control", "private, no-store")
        .send({ profile });
    } finally {
      resume.fill(0);
      resume = undefined;
    }
  });
};
