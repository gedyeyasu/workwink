import type { Locator, Page } from 'playwright';
import type { ApplicationLease } from './contracts.js';
import type { FieldSpec, ProviderAdapter } from './adapters/types.js';
import { firstUsable } from './adapters/types.js';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function locateByLabel(root: Locator, labels: string[]): Promise<Locator | undefined> {
  for (const label of labels) {
    const exact = root.getByLabel(new RegExp(`^\\s*${escapeRegExp(label)}\\s*(?:\\*)?\\s*$`, 'i')).first();
    if (await exact.count() > 0 && await exact.isVisible().catch(() => false) && await exact.isEnabled().catch(() => false)) {
      return exact;
    }
  }
  return undefined;
}

async function setControlValue(control: Locator, value: string | boolean | string[]): Promise<boolean> {
  const metadata = await control.evaluate((element) => ({
    tagName: element.tagName.toLowerCase(),
    type: element instanceof HTMLInputElement ? element.type.toLowerCase() : '',
    multiple: element instanceof HTMLSelectElement ? element.multiple : false,
  }));

  if (metadata.tagName === 'select') {
    const values = Array.isArray(value) ? value : [String(value)];
    if (values.length === 0) return false;
    try {
      await control.selectOption(values.map((label) => ({ label })));
    } catch {
      await control.selectOption(metadata.multiple ? values : values[0]!);
    }
    return true;
  }

  if (metadata.type === 'checkbox') {
    if (typeof value !== 'boolean') return false;
    if (value) await control.check();
    else await control.uncheck();
    return true;
  }

  // Radio groups require a user-reviewed exact choice. We never guess an
  // option based on substring matching.
  if (metadata.type === 'radio' || metadata.type === 'file') return false;
  if (typeof value !== 'string') return false;
  await control.fill(value);
  return true;
}

async function fillSpec(page: Page, root: Locator, spec: FieldSpec): Promise<boolean> {
  if (spec.value === undefined || spec.value === '') return false;
  const bySelector = await firstUsable(page, spec.selectors, root);
  const control = bySelector ?? await locateByLabel(root, spec.labels);
  if (!control) return false;
  return setControlValue(control, spec.value);
}

export async function openApplicationForm(page: Page, adapter: ProviderAdapter): Promise<Locator | undefined> {
  let root = await firstUsable(page, adapter.formRootSelectors);
  if (root) return root;

  const initialApply = await firstUsable(page, adapter.initialApplySelectors);
  if (!initialApply) return undefined;
  const type = await initialApply.getAttribute('type');
  if (type?.toLowerCase() === 'submit') return undefined;

  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined),
    initialApply.click(),
  ]);
  await page.waitForTimeout(750);
  root = await firstUsable(page, adapter.formRootSelectors);
  return root;
}

export async function fillApplicationForm(
  page: Page,
  root: Locator,
  adapter: ProviderAdapter,
  lease: ApplicationLease,
  resumeBuffer: Buffer | undefined,
): Promise<string[]> {
  const filled = new Set<string>();

  for (const spec of adapter.fields(lease)) {
    if (await fillSpec(page, root, spec).catch(() => false)) filled.add(spec.key);
  }

  if (resumeBuffer && lease.resume) {
    const fileInput = await firstUsable(page, [
      'input[type="file"][name*="resume" i]',
      'input[type="file"][id*="resume" i]',
      'input[type="file"]',
    ], root);
    if (fileInput) {
      await fileInput.setInputFiles({
        name: lease.resume.fileName,
        mimeType: 'application/pdf',
        buffer: resumeBuffer,
      });
      filled.add('resume');
    }
  }

  for (const [question, answer] of Object.entries(lease.answers)) {
    const control = await locateByLabel(root, [question]);
    if (!control) continue;

    const metadata = await control.evaluate((element) => ({
      type: element instanceof HTMLInputElement ? element.type.toLowerCase() : '',
    }));
    if (metadata.type === 'radio' && typeof answer === 'string') {
      const option = root.getByRole('radio', { name: new RegExp(`^\\s*${escapeRegExp(answer)}\\s*$`, 'i') }).first();
      if (await option.count() > 0 && await option.isVisible().catch(() => false)) {
        await option.check();
        filled.add(`answer:${question.slice(0, 80)}`);
      }
      continue;
    }

    if (await setControlValue(control, answer).catch(() => false)) {
      filled.add(`answer:${question.slice(0, 80)}`);
    }
  }

  return [...filled].sort();
}

export async function detectCaptcha(page: Page): Promise<boolean> {
  const selectors = [
    'iframe[src*="recaptcha" i]',
    'iframe[src*="hcaptcha" i]',
    'iframe[src*="challenges.cloudflare.com" i]',
    '[class*="captcha" i]',
    '[id*="captcha" i]',
    '[data-sitekey]',
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() > 0 && await locator.isVisible().catch(() => false)) return true;
  }
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 100_000);
  return /verify (?:that )?you are human|complete the security check|captcha/i.test(text);
}

export async function findMissingRequiredFields(root: Locator): Promise<string[]> {
  const missing = await root.locator('input[required], select[required], textarea[required], [aria-required="true"]').evaluateAll((elements) => {
    const names = new Set<string>();
    for (const raw of elements) {
      if (!(raw instanceof HTMLInputElement || raw instanceof HTMLSelectElement || raw instanceof HTMLTextAreaElement)) continue;
      if (raw.disabled || raw.type === 'hidden' || raw.type === 'submit' || raw.type === 'button') continue;
      const style = window.getComputedStyle(raw);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      let complete = true;
      if (raw instanceof HTMLInputElement && raw.type === 'radio') {
        const group = raw.form?.elements.namedItem(raw.name);
        if (group instanceof RadioNodeList) complete = group.value !== '';
        else complete = raw.checked;
      } else if (raw instanceof HTMLInputElement && raw.type === 'checkbox') {
        complete = raw.checked;
      } else if (raw instanceof HTMLInputElement && raw.type === 'file') {
        complete = (raw.files?.length ?? 0) > 0;
      } else {
        complete = raw.value.trim() !== '';
      }
      if (complete) continue;

      const labels = 'labels' in raw && raw.labels ? Array.from(raw.labels).map((label) => label.textContent?.trim()).filter(Boolean) : [];
      const name = labels[0]
        ?? raw.getAttribute('aria-label')
        ?? raw.getAttribute('placeholder')
        ?? raw.getAttribute('name')
        ?? raw.id
        ?? 'unknown required field';
      names.add(String(name).replace(/\s+/g, ' ').replace(/\s*\*\s*$/, '').slice(0, 200));
    }
    return [...names].slice(0, 100);
  });
  return missing.sort();
}

export async function clickFinalSubmit(page: Page, root: Locator, adapter: ProviderAdapter): Promise<boolean> {
  const submit = await firstUsable(page, adapter.submitSelectors, root);
  if (!submit) return false;
  await submit.click({ noWaitAfter: false });
  await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(1_500);
  return true;
}

export async function findConfirmation(page: Page, adapter: ProviderAdapter): Promise<string | undefined> {
  const text = (await page.locator('body').innerText().catch(() => '')).slice(0, 100_000);
  for (const pattern of adapter.confirmationPatterns) {
    const match = text.match(pattern);
    if (match?.[0]) return match[0].replace(/\s+/g, ' ').slice(0, 1_000);
  }
  return undefined;
}
