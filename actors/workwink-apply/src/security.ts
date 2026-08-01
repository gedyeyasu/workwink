import { createHash } from 'node:crypto';

const privateIpv4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^0\./,
];

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '');
}

export function isPrivateHostname(hostname: string): boolean {
  const value = normalizeHostname(hostname).replace(/^\[|\]$/g, '');
  return value === 'localhost'
    || value.endsWith('.localhost')
    || value.endsWith('.local')
    || value === '::1'
    || value.startsWith('fc')
    || value.startsWith('fd')
    || value.startsWith('fe80:')
    || privateIpv4.some((pattern) => pattern.test(value));
}

export function parsePublicHttpsUrl(rawUrl: string, purpose: string): URL {
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error(`${purpose} must use HTTPS`);
  if (url.username || url.password) throw new Error(`${purpose} cannot contain credentials`);
  if (url.port && url.port !== '443') throw new Error(`${purpose} cannot use a non-standard port`);
  if (isPrivateHostname(url.hostname)) throw new Error(`${purpose} cannot target a private host`);
  return url;
}

export function assertApiBaseUrl(rawUrl: string, allowedHostsEnv = process.env.WORKWINK_ALLOWED_API_HOSTS): URL {
  const url = parsePublicHttpsUrl(rawUrl, 'WorkWink API URL');
  const allowedHosts = (allowedHostsEnv ?? '')
    .split(',')
    .map(normalizeHostname)
    .filter(Boolean);

  if (allowedHosts.length > 0 && !allowedHosts.includes(normalizeHostname(url.hostname))) {
    throw new Error('WorkWink API host is not in WORKWINK_ALLOWED_API_HOSTS');
  }

  url.pathname = url.pathname.replace(/\/$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export function assertAllowedApplyUrl(rawUrl: string, allowedHosts: string[]): URL {
  const url = parsePublicHttpsUrl(rawUrl, 'Apply URL');
  const allowed = new Set(allowedHosts.map(normalizeHostname));
  if (!allowed.has(normalizeHostname(url.hostname))) {
    throw new Error('Apply URL host is not authorized by the application lease');
  }
  return url;
}

export function assertSameOrigin(rawUrl: string, apiBaseUrl: URL, purpose: string): URL {
  const url = parsePublicHttpsUrl(rawUrl, purpose);
  if (url.origin !== apiBaseUrl.origin) {
    throw new Error(`${purpose} must be served by the WorkWink API origin`);
  }
  return url;
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function isFutureIso(value: string, clockSkewMs = 5_000): boolean {
  return Date.parse(value) > Date.now() - clockSkewMs;
}
