import type { ProviderAdapter } from './types.js';

export const leverAdapter: ProviderAdapter = {
  provider: 'lever',
  formRootSelectors: ['form.application-form', 'form[action*="apply"]', 'form:has(input[name="email"]):has(input[name="name"])'],
  initialApplySelectors: ['a[href$="/apply"]', 'a.postings-btn[href*="apply"]', 'a:has-text("Apply for this job")'],
  submitSelectors: [
    'button[type="submit"]:has-text("Submit application")',
    'button[type="submit"]:has-text("Submit")',
    'input[type="submit"][value*="Submit"]',
  ],
  confirmationPatterns: [
    /application submitted/i,
    /thanks for applying/i,
    /thank you for applying/i,
  ],
  fields: (lease) => [
    { key: 'fullName', value: `${lease.applicant.firstName} ${lease.applicant.lastName}`, labels: ['Full name', 'Name'], selectors: ['input[name="name"]', 'input[autocomplete="name"]'] },
    { key: 'email', value: lease.applicant.email, labels: ['Email'], selectors: ['input[name="email"]', 'input[type="email"]'] },
    { key: 'phone', value: lease.applicant.phone, labels: ['Phone', 'Phone number'], selectors: ['input[name="phone"]', 'input[type="tel"]'] },
    { key: 'location', value: lease.applicant.location, labels: ['Location', 'Current location'], selectors: ['input[name="location"]'] },
    { key: 'linkedinUrl', value: lease.applicant.linkedinUrl, labels: ['LinkedIn', 'LinkedIn URL'], selectors: ['input[name*="urls[LinkedIn]"]', 'input[name*="linkedin" i]'] },
    { key: 'portfolioUrl', value: lease.applicant.portfolioUrl, labels: ['Portfolio', 'Website', 'Additional information URL'], selectors: ['input[name*="urls[Portfolio]"]', 'input[name*="portfolio" i]'] },
  ],
};
