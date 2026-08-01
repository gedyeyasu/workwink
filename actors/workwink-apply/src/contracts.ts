import { z } from 'zod';

export const runModeSchema = z.enum(['PREPARE', 'SUBMIT']);
export type RunMode = z.infer<typeof runModeSchema>;

export const actorInputSchema = z.strictObject({
  applicationId: z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$/),
  workwinkApiBaseUrl: z.string().url(),
  mode: runModeSchema.default('PREPARE'),
  dispatchToken: z.string().min(32).max(4096),
  approvalToken: z.string().min(32).max(4096).optional(),
  captureAuditScreenshot: z.boolean().default(false),
  navigationTimeoutSecs: z.number().int().min(15).max(120).default(45),
}).superRefine((input, context) => {
  if (input.mode === 'SUBMIT' && !input.approvalToken) {
    context.addIssue({
      code: 'custom',
      path: ['approvalToken'],
      message: 'SUBMIT requires an explicit, per-application approval token',
    });
  }
});

export type ActorInput = z.infer<typeof actorInputSchema>;

const applicantSchema = z.strictObject({
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120),
  email: z.string().email().max(320),
  phone: z.string().min(5).max(40).optional(),
  location: z.string().min(2).max(240).optional(),
  linkedinUrl: z.string().url().optional(),
  portfolioUrl: z.string().url().optional(),
});

const answerValueSchema = z.union([
  z.string().max(4_000),
  z.boolean(),
  z.array(z.string().max(500)).max(20),
]);

export const applicationLeaseSchema = z.strictObject({
  applicationId: z.string().min(8).max(128),
  leaseId: z.string().min(16).max(256),
  idempotencyKey: z.string().min(16).max(256),
  expiresAt: z.string().datetime(),
  provider: z.enum(['greenhouse', 'ashby', 'lever']),
  applyUrl: z.string().url(),
  allowedApplyHosts: z.array(z.string().min(1).max(253)).min(1).max(5),
  applicant: applicantSchema,
  resume: z.strictObject({
    downloadUrl: z.string().url(),
    fileName: z.string().min(1).max(160).regex(/\.pdf$/i),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).optional(),
  answers: z.record(z.string().min(1).max(500), answerValueSchema).default({}),
  submissionAuthorized: z.boolean(),
  approval: z.strictObject({
    applicationId: z.string().min(8).max(128),
    approvedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    scope: z.literal('single_application'),
  }).optional(),
  priorSubmission: z.strictObject({
    submittedAt: z.string().datetime(),
    confirmationText: z.string().max(1_000).optional(),
  }).optional(),
});

export type ApplicationLease = z.infer<typeof applicationLeaseSchema>;

export const resultStatusSchema = z.enum(['PREPARED', 'SUBMITTED', 'NEEDS_USER', 'FAILED']);

export const actorResultSchema = z.strictObject({
  applicationId: z.string(),
  leaseId: z.string(),
  mode: runModeSchema,
  provider: z.enum(['greenhouse', 'ashby', 'lever']).optional(),
  status: resultStatusSchema,
  reasonCode: z.enum([
    'READY_FOR_REVIEW',
    'SUBMISSION_CONFIRMED',
    'ALREADY_SUBMITTED',
    'CAPTCHA_DETECTED',
    'MISSING_REQUIRED_FIELDS',
    'UNSUPPORTED_FORM',
    'SUBMISSION_NOT_CONFIRMED',
    'AUTHORIZATION_REJECTED',
    'LEASE_EXPIRED',
    'NAVIGATION_FAILED',
    'INTERNAL_ERROR',
  ]),
  filledFields: z.array(z.string()).max(100),
  missingRequiredFields: z.array(z.string()).max(100),
  captchaDetected: z.boolean(),
  finalUrl: z.string().url().optional(),
  confirmationText: z.string().max(1_000).optional(),
  screenshotKey: z.string().max(200).optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
});

export type ActorResult = z.infer<typeof actorResultSchema>;
