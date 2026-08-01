import { describe, expect, it } from 'vitest';
import { actorInputSchema, applicationLeaseSchema } from '../src/contracts.js';

const baseInput = {
  applicationId: 'app_01ABCDEF',
  workwinkApiBaseUrl: 'https://workwink.example.com',
  dispatchToken: 'd'.repeat(32),
};

describe('Actor input approval gate', () => {
  it('defaults to PREPARE mode', () => {
    expect(actorInputSchema.parse(baseInput).mode).toBe('PREPARE');
  });

  it('rejects SUBMIT without a per-application approval token', () => {
    expect(() => actorInputSchema.parse({ ...baseInput, mode: 'SUBMIT' })).toThrow(/approval token/i);
  });

  it('accepts SUBMIT only when the explicit token is present', () => {
    const parsed = actorInputSchema.parse({
      ...baseInput,
      mode: 'SUBMIT',
      approvalToken: 'a'.repeat(32),
    });
    expect(parsed.mode).toBe('SUBMIT');
  });
});

describe('application lease contract', () => {
  it('requires the API to bind the job, applicant and host allowlist', () => {
    const lease = applicationLeaseSchema.parse({
      applicationId: baseInput.applicationId,
      leaseId: 'lease_1234567890123456',
      idempotencyKey: 'idempotency_123456789',
      expiresAt: '2099-01-01T00:00:00.000Z',
      provider: 'ashby',
      applyUrl: 'https://jobs.ashbyhq.com/apify/example',
      allowedApplyHosts: ['jobs.ashbyhq.com'],
      applicant: {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'ada@example.com',
      },
      answers: {},
      submissionAuthorized: false,
    });
    expect(lease.provider).toBe('ashby');
    expect(lease.allowedApplyHosts).toEqual(['jobs.ashbyhq.com']);
  });
});
