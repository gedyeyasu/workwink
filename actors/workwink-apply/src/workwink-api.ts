import type { ActorInput, ActorResult, ApplicationLease } from './contracts.js';
import { applicationLeaseSchema } from './contracts.js';
import { assertSameOrigin, sha256 } from './security.js';

const MAX_API_RESPONSE_BYTES = 1_000_000;
const MAX_RESUME_BYTES = 5 * 1024 * 1024;

async function boundedText(response: Response, maxBytes = MAX_API_RESPONSE_BYTES): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > maxBytes) throw new Error('WorkWink API response exceeded the size limit');
  const body = await response.text();
  if (Buffer.byteLength(body, 'utf8') > maxBytes) throw new Error('WorkWink API response exceeded the size limit');
  return body;
}

function endpoint(apiBaseUrl: URL, path: string): URL {
  return new URL(`${apiBaseUrl.pathname}${path}`.replace(/\/+/g, '/'), apiBaseUrl.origin);
}

export async function acquireApplicationLease(input: ActorInput, apiBaseUrl: URL): Promise<ApplicationLease> {
  const url = endpoint(apiBaseUrl, `/api/internal/applications/${encodeURIComponent(input.applicationId)}/actor-lease`);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${input.dispatchToken}`,
      'content-type': 'application/json',
      'user-agent': 'WorkWink-Apply-Actor/0.1',
    },
    body: JSON.stringify({
      mode: input.mode,
      ...(input.approvalToken ? { approvalToken: input.approvalToken } : {}),
    }),
  });

  const body = await boundedText(response);
  if (!response.ok) {
    throw new Error(`WorkWink rejected the application lease (${response.status})`);
  }

  const lease = applicationLeaseSchema.parse(JSON.parse(body));
  if (lease.applicationId !== input.applicationId) {
    throw new Error('Application lease is bound to a different application');
  }
  return lease;
}

export async function downloadResume(lease: ApplicationLease, apiBaseUrl: URL): Promise<Buffer | undefined> {
  if (!lease.resume) return undefined;
  const url = assertSameOrigin(lease.resume.downloadUrl, apiBaseUrl, 'Resume download URL');
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      'x-workwink-lease': lease.leaseId,
      'user-agent': 'WorkWink-Apply-Actor/0.1',
    },
  });
  if (!response.ok) throw new Error(`Resume download failed (${response.status})`);

  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > MAX_RESUME_BYTES) throw new Error('Resume exceeds the 5 MiB Actor limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_RESUME_BYTES) throw new Error('Resume exceeds the 5 MiB Actor limit');
  if (sha256(buffer) !== lease.resume.sha256) throw new Error('Resume integrity check failed');
  return buffer;
}

export async function reportApplicationResult(
  result: ActorResult,
  input: ActorInput,
  apiBaseUrl: URL,
): Promise<void> {
  const url = endpoint(apiBaseUrl, `/api/internal/applications/${encodeURIComponent(input.applicationId)}/actor-result`);
  const response = await fetch(url, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
    headers: {
      authorization: `Bearer ${input.dispatchToken}`,
      'content-type': 'application/json',
      'idempotency-key': `${result.leaseId}:${result.status}`,
      'user-agent': 'WorkWink-Apply-Actor/0.1',
    },
    body: JSON.stringify(result),
  });

  if (!response.ok) {
    await boundedText(response).catch(() => '');
    throw new Error(`WorkWink result callback failed (${response.status})`);
  }
}
