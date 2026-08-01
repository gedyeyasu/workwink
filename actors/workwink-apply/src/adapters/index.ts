import type { Page } from 'playwright';
import type { Provider } from './types.js';
import { ashbyAdapter } from './ashby.js';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';

const adapters = {
  greenhouse: greenhouseAdapter,
  ashby: ashbyAdapter,
  lever: leverAdapter,
} as const;

export function providerFromUrl(rawUrl: string): Provider | undefined {
  const hostname = new URL(rawUrl).hostname.toLowerCase();
  if (hostname === 'jobs.ashbyhq.com' || hostname.endsWith('.ashbyhq.com')) return 'ashby';
  if (hostname === 'jobs.lever.co' || hostname.endsWith('.lever.co')) return 'lever';
  if (hostname.includes('greenhouse.io')) return 'greenhouse';
  return undefined;
}

export async function detectProvider(page: Page, providerHint: Provider): Promise<Provider | undefined> {
  const fromUrl = providerFromUrl(page.url());
  if (fromUrl) return fromUrl;

  const signals: Record<Provider, string[]> = {
    greenhouse: ['#application_form', 'form[action*="greenhouse"]', 'script[src*="greenhouse.io"]'],
    ashby: ['[data-testid*="ashby"]', 'script[src*="ashbyhq.com"]', 'a[href*="ashbyhq.com"]'],
    lever: ['form.application-form', '[class*="lever"]', 'script[src*="lever.co"]'],
  };

  for (const provider of Object.keys(signals) as Provider[]) {
    for (const selector of signals[provider]) {
      if (await page.locator(selector).count() > 0) return provider;
    }
  }

  // The hint was signed into the WorkWink lease. It is accepted only after the
  // apply host itself has already passed the lease allowlist.
  return providerHint;
}

export function getAdapter(provider: Provider) {
  return adapters[provider];
}
