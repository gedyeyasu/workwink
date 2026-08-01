import { describe, expect, it } from 'vitest';
import { getAdapter, providerFromUrl } from '../src/adapters/index.js';

describe('ATS adapters', () => {
  it.each([
    ['https://boards.greenhouse.io/company/jobs/123', 'greenhouse'],
    ['https://job-boards.eu.greenhouse.io/company/jobs/123', 'greenhouse'],
    ['https://jobs.ashbyhq.com/apify/role', 'ashby'],
    ['https://jobs.lever.co/company/role/apply', 'lever'],
  ] as const)('detects %s as %s', (url, provider) => {
    expect(providerFromUrl(url)).toBe(provider);
  });

  it('does not claim arbitrary company sites from URL alone', () => {
    expect(providerFromUrl('https://careers.example.com/jobs/1')).toBeUndefined();
  });

  it.each(['greenhouse', 'ashby', 'lever'] as const)('defines an explicit final-submit selector for %s', (provider) => {
    expect(getAdapter(provider).submitSelectors.length).toBeGreaterThan(0);
  });
});
