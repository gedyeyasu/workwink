import type { Locator, Page } from 'playwright';
import type { ApplicationLease } from '../contracts.js';

export type Provider = ApplicationLease['provider'];

export interface FieldSpec {
  key: string;
  value: string | boolean | string[] | undefined;
  labels: string[];
  selectors: string[];
}

export interface ProviderAdapter {
  provider: Provider;
  formRootSelectors: string[];
  initialApplySelectors: string[];
  submitSelectors: string[];
  confirmationPatterns: RegExp[];
  fields(lease: ApplicationLease): FieldSpec[];
}

export interface FillResult {
  filledFields: string[];
}

export async function firstUsable(page: Page, selectors: string[], root?: Locator): Promise<Locator | undefined> {
  for (const selector of selectors) {
    const locator = (root ?? page.locator('html')).locator(selector).first();
    if (await locator.count() > 0 && await locator.isVisible().catch(() => false) && await locator.isEnabled().catch(() => false)) {
      return locator;
    }
  }
  return undefined;
}
