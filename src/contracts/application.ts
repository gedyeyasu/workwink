import { z } from "zod";
import { workModeSchema } from "./job.js";

export const applicationStatusSchema = z.enum([
  "saved",
  "package_ready",
  "awaiting_approval",
  "approved",
  "queued",
  "actor_running",
  "submitted",
  "needs_user",
  "failed"
]);

export const applicationActionSchema = z.enum([
  "package_ready",
  "request_approval",
  "approve"
]);

export const jobSnapshotSchema = z.object({
  title: z.string().min(1).max(500),
  companyName: z.string().min(1).max(300),
  location: z.string().min(1).max(500),
  workMode: workModeSchema,
  applyUrl: z.string().url(),
  sourceUrl: z.string().url()
}).strict();

export const applicationSchema = z.object({
  applicationId: z.string().regex(/^app_[a-f0-9]{40}$/),
  jobId: z.string().min(8).max(256),
  jobSnapshot: jobSnapshotSchema,
  status: applicationStatusSchema,
  savedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
  schemaVersion: z.literal(1)
}).strict();

export const saveApplicationSchema = z.object({
  jobId: z.string().trim().min(8).max(256)
}).strict();

export const transitionApplicationSchema = z.object({
  action: applicationActionSchema
}).strict();

export const applicationIdSchema = z.string().regex(/^app_[a-f0-9]{40}$/);

export type Application = z.infer<typeof applicationSchema>;
export type ApplicationAction = z.infer<typeof applicationActionSchema>;
export type ApplicationStatus = z.infer<typeof applicationStatusSchema>;
export type JobSnapshot = z.infer<typeof jobSnapshotSchema>;

