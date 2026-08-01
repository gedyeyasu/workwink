import type { ProviderAdapter } from './types.js';

export const ashbyAdapter: ProviderAdapter = {
  provider: 'ashby',
  formRootSelectors: ['[data-testid*="application-form"]', 'form:has(input[type="file"])', 'form:has(input[autocomplete="name"])'],
  initialApplySelectors: [
    'a[href*="/application"]',
    'button:has-text("Apply for this Job")',
    'button:has-text("Apply Now")',
    'button:has-text("Apply")',
  ],
  submitSelectors: [
    'button[type="submit"]:has-text("Submit Application")',
    'button[type="submit"]:has-text("Submit")',
  ],
  confirmationPatterns: [
    /application submitted/i,
    /thank you for applying/i,
    /we(?:'|’)ve received your application/i,
  ],
  fields: (lease) => [
    { key: 'fullName', value: `${lease.applicant.firstName} ${lease.applicant.lastName}`, labels: ['Name', 'Full name'], selectors: ['input[name*="_systemfield_name" i]', 'input[autocomplete="name"]'] },
    { key: 'email', value: lease.applicant.email, labels: ['Email'], selectors: ['input[name*="_systemfield_email" i]', 'input[type="email"]'] },
    { key: 'phone', value: lease.applicant.phone, labels: ['Phone', 'Phone number'], selectors: ['input[name*="_systemfield_phone" i]', 'input[type="tel"]'] },
    { key: 'location', value: lease.applicant.location, labels: ['Location', 'Current location'], selectors: ['input[name*="location" i]'] },
    { key: 'linkedinUrl', value: lease.applicant.linkedinUrl, labels: ['LinkedIn', 'LinkedIn URL'], selectors: ['input[name*="linkedin" i]'] },
    { key: 'portfolioUrl', value: lease.applicant.portfolioUrl, labels: ['Portfolio', 'Website', 'Personal website'], selectors: ['input[name*="portfolio" i]', 'input[name*="website" i]'] },
  ],
};
