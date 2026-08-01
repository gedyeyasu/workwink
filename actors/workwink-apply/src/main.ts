import { Actor, log } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import type { Page } from 'playwright';
import { actorInputSchema, actorResultSchema, type ActorInput, type ActorResult, type ApplicationLease } from './contracts.js';
import { detectProvider, getAdapter } from './adapters/index.js';
import {
  clickFinalSubmit,
  detectCaptcha,
  fillApplicationForm,
  findConfirmation,
  findMissingRequiredFields,
  openApplicationForm,
} from './form-automation.js';
import { assertAllowedApplyUrl, assertApiBaseUrl, isFutureIso } from './security.js';
import { acquireApplicationLease, downloadResume, reportApplicationResult } from './workwink-api.js';

function safePageUrl(page: Page): string | undefined {
  try {
    const url = new URL(page.url());
    if (url.protocol !== 'https:') return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function baseResult(input: ActorInput, leaseId: string, startedAt: string): Omit<ActorResult, 'status' | 'reasonCode' | 'finishedAt'> {
  return {
    applicationId: input.applicationId,
    leaseId,
    mode: input.mode,
    filledFields: [],
    missingRequiredFields: [],
    captchaDetected: false,
    startedAt,
  };
}

function validateSubmitAuthorization(input: ActorInput, lease: ApplicationLease): void {
  if (input.mode !== 'SUBMIT') return;
  if (!input.approvalToken || !lease.submissionAuthorized || !lease.approval) {
    throw new Error('AUTHORIZATION_REJECTED');
  }
  if (lease.approval.applicationId !== input.applicationId || lease.approval.scope !== 'single_application') {
    throw new Error('AUTHORIZATION_REJECTED');
  }
  if (!isFutureIso(lease.approval.expiresAt)) throw new Error('AUTHORIZATION_REJECTED');
}

async function automate(
  input: ActorInput,
  lease: ApplicationLease,
  resumeBuffer: Buffer | undefined,
  startedAt: string,
): Promise<ActorResult> {
  let result: ActorResult | undefined;
  const applyUrl = assertAllowedApplyUrl(lease.applyUrl, lease.allowedApplyHosts);
  const crawler = new PlaywrightCrawler({
    maxConcurrency: 1,
    maxRequestsPerCrawl: 1,
    maxRequestRetries: 0,
    requestHandlerTimeoutSecs: input.navigationTimeoutSecs,
    navigationTimeoutSecs: input.navigationTimeoutSecs,
    launchContext: {
      launchOptions: { headless: true },
    },
    async requestHandler({ page }) {
      const common = baseResult(input, lease.leaseId, startedAt);
      const provider = await detectProvider(page, lease.provider);
      if (!provider) {
        result = actorResultSchema.parse({
          ...common,
          status: 'NEEDS_USER',
          reasonCode: 'UNSUPPORTED_FORM',
          finishedAt: new Date().toISOString(),
          finalUrl: safePageUrl(page),
        });
        return;
      }

      const adapter = getAdapter(provider);
      if (await detectCaptcha(page)) {
        result = actorResultSchema.parse({
          ...common,
          provider,
          status: 'NEEDS_USER',
          reasonCode: 'CAPTCHA_DETECTED',
          captchaDetected: true,
          finalUrl: safePageUrl(page),
          finishedAt: new Date().toISOString(),
        });
        return;
      }

      const root = await openApplicationForm(page, adapter);
      if (!root) {
        result = actorResultSchema.parse({
          ...common,
          provider,
          status: 'NEEDS_USER',
          reasonCode: 'UNSUPPORTED_FORM',
          finalUrl: safePageUrl(page),
          finishedAt: new Date().toISOString(),
        });
        return;
      }

      const filledFields = await fillApplicationForm(page, root, adapter, lease, resumeBuffer);
      const captchaDetected = await detectCaptcha(page);
      const missingRequiredFields = await findMissingRequiredFields(root);

      let screenshotKey: string | undefined;
      if (input.captureAuditScreenshot) {
        screenshotKey = `AUDIT-${input.applicationId}-${Date.now()}`;
        await Actor.setValue(screenshotKey, await page.screenshot({ fullPage: true }), { contentType: 'image/png' });
      }

      const state = {
        ...common,
        provider,
        filledFields,
        missingRequiredFields,
        captchaDetected,
        finalUrl: safePageUrl(page),
        ...(screenshotKey ? { screenshotKey } : {}),
      };

      if (captchaDetected) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'CAPTCHA_DETECTED', finishedAt: new Date().toISOString() });
        return;
      }
      if (missingRequiredFields.length > 0) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'MISSING_REQUIRED_FIELDS', finishedAt: new Date().toISOString() });
        return;
      }
      if (input.mode === 'PREPARE') {
        result = actorResultSchema.parse({ ...state, status: 'PREPARED', reasonCode: 'READY_FOR_REVIEW', finishedAt: new Date().toISOString() });
        return;
      }

      // This is the only final-submit call in the codebase. Rechecks happen
      // immediately before it, and crawler retries are disabled to prevent a
      // duplicate submission after an ambiguous response.
      validateSubmitAuthorization(input, lease);
      if (await detectCaptcha(page)) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'CAPTCHA_DETECTED', captchaDetected: true, finishedAt: new Date().toISOString() });
        return;
      }
      const lastMissingCheck = await findMissingRequiredFields(root);
      if (lastMissingCheck.length > 0) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'MISSING_REQUIRED_FIELDS', missingRequiredFields: lastMissingCheck, finishedAt: new Date().toISOString() });
        return;
      }

      if (!await clickFinalSubmit(page, root, adapter)) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'UNSUPPORTED_FORM', finishedAt: new Date().toISOString() });
        return;
      }

      const postSubmitCaptcha = await detectCaptcha(page);
      if (postSubmitCaptcha) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'CAPTCHA_DETECTED', captchaDetected: true, finalUrl: safePageUrl(page), finishedAt: new Date().toISOString() });
        return;
      }

      const confirmationText = await findConfirmation(page, adapter);
      if (!confirmationText) {
        result = actorResultSchema.parse({ ...state, status: 'NEEDS_USER', reasonCode: 'SUBMISSION_NOT_CONFIRMED', finalUrl: safePageUrl(page), finishedAt: new Date().toISOString() });
        return;
      }

      result = actorResultSchema.parse({
        ...state,
        status: 'SUBMITTED',
        reasonCode: 'SUBMISSION_CONFIRMED',
        finalUrl: safePageUrl(page),
        confirmationText,
        finishedAt: new Date().toISOString(),
      });
    },
    async failedRequestHandler({ request }, error) {
      log.error('Application page navigation failed', { applicationId: input.applicationId, requestId: request.id, error: error.message });
    },
  });

  await crawler.run([{ url: applyUrl.toString(), uniqueKey: lease.idempotencyKey }]);
  return result ?? actorResultSchema.parse({
    ...baseResult(input, lease.leaseId, startedAt),
    provider: lease.provider,
    status: 'FAILED',
    reasonCode: 'NAVIGATION_FAILED',
    finishedAt: new Date().toISOString(),
  });
}

await Actor.init();
const startedAt = new Date().toISOString();
let input: ActorInput | undefined;
let lease: ApplicationLease | undefined;
let resumeBuffer: Buffer | undefined;
let result: ActorResult | undefined;

try {
  input = actorInputSchema.parse(await Actor.getInput());
  const apiBaseUrl = assertApiBaseUrl(input.workwinkApiBaseUrl);
  log.info('Starting approval-gated application run', { applicationId: input.applicationId, mode: input.mode });

  lease = await acquireApplicationLease(input, apiBaseUrl);
  if (!isFutureIso(lease.expiresAt)) throw new Error('LEASE_EXPIRED');
  validateSubmitAuthorization(input, lease);

  if (lease.priorSubmission) {
    result = actorResultSchema.parse({
      ...baseResult(input, lease.leaseId, startedAt),
      provider: lease.provider,
      status: 'SUBMITTED',
      reasonCode: 'ALREADY_SUBMITTED',
      ...(lease.priorSubmission.confirmationText ? { confirmationText: lease.priorSubmission.confirmationText } : {}),
      finishedAt: new Date().toISOString(),
    });
  } else {
    resumeBuffer = await downloadResume(lease, apiBaseUrl);
    result = await automate(input, lease, resumeBuffer, startedAt);
  }

  await Actor.pushData(result);
  await reportApplicationResult(result, input, apiBaseUrl).catch((error: unknown) => {
    log.warning('Could not report result to WorkWink; dataset result remains authoritative', {
      applicationId: input?.applicationId,
      error: error instanceof Error ? error.message : 'Unknown callback error',
    });
  });
  log.info('Application run finished', { applicationId: input.applicationId, status: result.status, reasonCode: result.reasonCode });
} catch (error) {
  const message = error instanceof Error ? error.message : 'INTERNAL_ERROR';
  const reasonCode = message === 'LEASE_EXPIRED'
    ? 'LEASE_EXPIRED'
    : message === 'AUTHORIZATION_REJECTED' || message.includes('rejected')
      ? 'AUTHORIZATION_REJECTED'
      : 'INTERNAL_ERROR';
  const failure = actorResultSchema.parse({
    applicationId: input?.applicationId ?? 'invalid-input',
    leaseId: lease?.leaseId ?? 'not-issued',
    mode: input?.mode ?? 'PREPARE',
    ...(lease?.provider ? { provider: lease.provider } : {}),
    status: 'FAILED',
    reasonCode,
    filledFields: [],
    missingRequiredFields: [],
    captchaDetected: false,
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  await Actor.pushData(failure);
  log.error('Application run failed closed', {
    applicationId: input?.applicationId,
    reasonCode,
    error: message,
  });
  process.exitCode = 1;
} finally {
  resumeBuffer?.fill(0);
  await Actor.exit();
}
