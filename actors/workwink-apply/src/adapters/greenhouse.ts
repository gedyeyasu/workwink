import type { ProviderAdapter } from './types.js';

export const greenhouseAdapter: ProviderAdapter = {
  provider: 'greenhouse',
  formRootSelectors: ['#application_form', 'form[action*="application"]', 'form#application'],
  initialApplySelectors: [
    'a[href*="#application"]',
    'a[href*="/apply"]',
    'button:has-text("Apply for this job")',
    'button:has-text("Apply now")',
  ],
  submitSelectors: [
    '#submit_app',
    'button[type="submit"]:has-text("Submit")',
    'input[type="submit"][value*="Submit"]',
  ],
  confirmationPatterns: [
    /thank you for applying/i,
    /application (?:was |has been )?submitted/i,
    /we(?:'|’)ve received your application/i,
  ],
  fields: (lease) => [
    { key: 'firstName', value: lease.applicant.firstName, labels: ['First name'], selectors: ['#first_name', 'input[name="job_application[first_name]"]', 'input[name="first_name"]'] },
    { key: 'lastName', value: lease.applicant.lastName, labels: ['Last name'], selectors: ['#last_name', 'input[name="job_application[last_name]"]', 'input[name="last_name"]'] },
    { key: 'email', value: lease.applicant.email, labels: ['Email'], selectors: ['#email', 'input[name="job_application[email]"]', 'input[type="email"]'] },
    { key: 'phone', value: lease.applicant.phone, labels: ['Phone', 'Phone number'], selectors: ['#phone', 'input[name="job_application[phone]"]', 'input[type="tel"]'] },
    { key: 'location', value: lease.applicant.location, labels: ['Location', 'Current location'], selectors: ['input[name*="location"]'] },
    { key: 'linkedinUrl', value: lease.applicant.linkedinUrl, labels: ['LinkedIn', 'LinkedIn profile'], selectors: ['input[name*="linkedin" i]'] },
    { key: 'portfolioUrl', value: lease.applicant.portfolioUrl, labels: ['Portfolio', 'Website', 'Personal website'], selectors: ['input[name*="portfolio" i]', 'input[name*="website" i]'] },
  ],
};
