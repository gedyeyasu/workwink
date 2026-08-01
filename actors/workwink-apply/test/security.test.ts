import { describe, expect, it } from 'vitest';
import {
  assertAllowedApplyUrl,
  assertApiBaseUrl,
  assertSameOrigin,
  isPrivateHostname,
} from '../src/security.js';

describe('network boundaries', () => {
  it.each(['localhost', '127.0.0.1', '10.2.3.4', '172.20.1.2', '192.168.1.10', '::1'])('rejects private host %s', (host) => {
    expect(isPrivateHostname(host)).toBe(true);
  });

  it('pins the orchestration API to its deployment allowlist', () => {
    expect(assertApiBaseUrl('https://workwink.example.com', 'workwink.example.com').hostname).toBe('workwink.example.com');
    expect(() => assertApiBaseUrl('https://attacker.example', 'workwink.example.com')).toThrow(/not in/i);
  });

  it('accepts only an apply URL signed into the lease host list', () => {
    expect(assertAllowedApplyUrl('https://jobs.ashbyhq.com/apify/role', ['jobs.ashbyhq.com']).hostname).toBe('jobs.ashbyhq.com');
    expect(() => assertAllowedApplyUrl('https://example.com/steal', ['jobs.ashbyhq.com'])).toThrow(/not authorized/i);
  });

  it('requires resume bytes to come from the same WorkWink origin', () => {
    const api = new URL('https://workwink.example.com');
    expect(assertSameOrigin('https://workwink.example.com/api/resume/1', api, 'Resume').origin).toBe(api.origin);
    expect(() => assertSameOrigin('https://files.example.com/resume.pdf', api, 'Resume')).toThrow(/origin/i);
  });
});
