export const OFFICIAL_WEB_SCRAPER_ACTOR_ID = "apify/web-scraper" as const;

/** Sponsor-owned career sources used by the saved hackathon demo task. */
export const SPONSOR_JOB_BOARD_URLS = [
  "https://jobs.ashbyhq.com/apify",
  "https://boards-api.greenhouse.io/v1/boards/elastic/jobs?content=true"
] as const;

export const SUPPORTED_JOB_BOARD_HOSTS = [
  "boards.greenhouse.io",
  "job-boards.greenhouse.io",
  "boards-api.greenhouse.io",
  "jobs.lever.co",
  "jobs.ashbyhq.com"
] as const;

export type JobBoardProvider = "greenhouse" | "lever" | "ashby";

export interface WebScraperInputOptions {
  maxPages?: number;
  maxResults?: number;
  maxConcurrency?: number;
}

export interface WebScraperInput {
  runMode: "PRODUCTION";
  startUrls: Array<{ url: string }>;
  respectRobotsTxtFile: true;
  linkSelector: string;
  globs: never[];
  pseudoUrls: never[];
  excludes: Array<{ glob: string }>;
  pageFunction: string;
  injectJQuery: false;
  proxyConfiguration: { useApifyProxy: true };
  maxRequestRetries: number;
  maxPagesPerCrawl: number;
  maxResultsPerCrawl: number;
  maxCrawlingDepth: number;
  maxConcurrency: number;
  pageLoadTimeoutSecs: number;
  pageFunctionTimeoutSecs: number;
  waitUntil: ["networkidle2"];
  maxScrollHeightPixels: number;
  downloadMedia: false;
  downloadCss: false;
  customData: {
    sourceActor: typeof OFFICIAL_WEB_SCRAPER_ACTOR_ID;
    schemaVersion: 1;
    maxLinksPerPage: number;
  };
}

/**
 * Runs inside the official Apify Web Scraper browser. Listing pages only enqueue
 * provider-specific job-detail links; only JSON-LD JobPosting records are emitted.
 */
export const JOB_BOARD_PAGE_FUNCTION = String.raw`async function pageFunction(context) {
    const requestedUrl = context.request.url;
    const pageUrl = context.request.loadedUrl || requestedUrl;
    const extractedAt = new Date().toISOString();

    function providerFor(urlValue) {
        const host = new URL(urlValue).hostname.toLowerCase();
        if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io') return 'greenhouse';
        if (host === 'boards-api.greenhouse.io') return 'greenhouse';
        if (host === 'jobs.lever.co') return 'lever';
        if (host === 'jobs.ashbyhq.com') return 'ashby';
        return null;
    }

    function isJobDetail(urlValue, provider) {
        const candidate = new URL(urlValue);
        const path = candidate.pathname.replace(/\/+$/, '');
        const segments = path.split('/').filter(Boolean);
        if (provider === 'greenhouse') {
            return /\/jobs\/\d+(?:\/|$)/.test(path)
                || (path.endsWith('/embed/job_app') && candidate.searchParams.has('token'));
        }
        if (provider === 'lever') {
            return segments.length >= 2 && segments[segments.length - 1] !== 'apply';
        }
        if (provider === 'ashby') return segments.length >= 2;
        return false;
    }

    function normalizeUrl(urlValue) {
        const normalized = new URL(urlValue, pageUrl);
        normalized.hash = '';
        if (normalized.hostname === 'jobs.lever.co') {
            normalized.pathname = normalized.pathname.replace(/\/apply\/?$/, '');
        }
        return normalized.href;
    }

    const provider = providerFor(pageUrl);
    if (!provider) {
        context.log.warning('Ignoring unsupported job-board host', { pageUrl });
        return null;
    }

    // Some companies, including Elastic, use a custom careers frontend while
    // retaining Greenhouse's public board API. With content=true, one official
    // Actor request yields the complete public board JSON. Convert each record
    // into the same JobPosting envelope used by HTML sources.
    if (new URL(pageUrl).hostname === 'boards-api.greenhouse.io') {
        let payload;
        try {
            payload = JSON.parse(document.body.innerText || document.body.textContent || '');
        } catch (error) {
            throw new Error('Greenhouse board API did not return valid JSON: ' + String(error));
        }
        const jobs = Array.isArray(payload.jobs) ? payload.jobs : [];
        const pathParts = new URL(pageUrl).pathname.split('/').filter(Boolean);
        const boardToken = pathParts[pathParts.indexOf('boards') + 1] || 'Company';
        const companyName = boardToken.charAt(0).toUpperCase() + boardToken.slice(1);
        return jobs.flatMap((job) => {
            if (!job || typeof job !== 'object' || !job.id || !job.title || !job.absolute_url || !job.content) return [];
            const sourceUrl = normalizeUrl(job.absolute_url);
            return [{
                schemaVersion: context.customData.schemaVersion,
                sourceActor: context.customData.sourceActor,
                provider: 'greenhouse',
                sourceUrl,
                scrapedAt: extractedAt,
                pageUrl,
                requestedUrl,
                canonicalUrl: sourceUrl,
                crawledAt: extractedAt,
                jobPosting: {
                    '@context': 'https://schema.org/',
                    '@type': 'JobPosting',
                    title: job.title,
                    description: job.content,
                    identifier: { '@type': 'PropertyValue', name: companyName, value: String(job.id) },
                    hiringOrganization: { '@type': 'Organization', name: companyName },
                    jobLocation: job.location && job.location.name
                        ? { '@type': 'Place', address: { '@type': 'PostalAddress', addressLocality: job.location.name } }
                        : undefined,
                    datePosted: job.first_published || job.updated_at || undefined,
                    url: sourceUrl
                },
                provenance: {
                    actor: context.customData.sourceActor,
                    provider: 'greenhouse',
                    requestedUrl,
                    loadedUrl: pageUrl,
                    canonicalUrl: sourceUrl,
                    greenhouseJobId: String(job.id),
                    extractedAt
                }
            }];
        });
    }

    const discovered = new Set();
    const maxLinks = Number(context.customData.maxLinksPerPage) || 2000;
    for (const anchor of document.querySelectorAll('a[href]')) {
        if (discovered.size >= maxLinks) break;
        try {
            const candidate = normalizeUrl(anchor.href);
            if (providerFor(candidate) !== provider || !isJobDetail(candidate, provider)) continue;
            discovered.add(candidate);
        } catch (_) {
            // Ignore malformed links from third-party widgets.
        }
    }

    // Ashby server-renders its listing inventory into window.__appData and may
    // hydrate cards without crawlable anchors. Traverse that trusted page-local
    // data only to discover UUID detail routes; job content still comes from
    // JSON-LD on each detail page.
    if (provider === 'ashby') {
        const rootSegment = new URL(pageUrl).pathname.split('/').filter(Boolean)[0];
        const visited = new WeakSet();
        function discoverAshbyJobs(value) {
            if (!value || typeof value !== 'object' || visited.has(value)) return;
            visited.add(value);
            if (typeof value.id === 'string'
                && /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value.id)
                && typeof value.title === 'string'
                && rootSegment) {
                discovered.add(new URL('/' + rootSegment + '/' + value.id, pageUrl).href);
            }
            for (const child of Object.values(value)) discoverAshbyJobs(child);
        }
        discoverAshbyJobs(window.__appData);
    }

    for (const url of discovered) {
        if (url === normalizeUrl(pageUrl)) continue;
        await context.enqueueRequest({
            url,
            userData: { provider, discoveredFrom: pageUrl }
        });
    }

    function collectJobPostings(value, scriptIndex, output) {
        if (!value) return;
        if (Array.isArray(value)) {
            for (const entry of value) collectJobPostings(entry, scriptIndex, output);
            return;
        }
        if (typeof value !== 'object') return;

        const type = value['@type'];
        const types = Array.isArray(type) ? type : [type];
        if (types.includes('JobPosting')) output.push({ jobPosting: value, scriptIndex });
        if (Array.isArray(value['@graph'])) {
            collectJobPostings(value['@graph'], scriptIndex, output);
        }
    }

    const postings = [];
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    scripts.forEach((script, scriptIndex) => {
        try {
            collectJobPostings(JSON.parse(script.textContent || ''), scriptIndex, postings);
        } catch (error) {
            context.log.debug('Skipping malformed JSON-LD', {
                pageUrl,
                scriptIndex,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    });

    if (postings.length === 0) return null;

    const canonicalElement = document.querySelector('link[rel="canonical"]');
    const canonicalHref = canonicalElement && canonicalElement.href;
    const seen = new Set();
    return postings.flatMap(({ jobPosting, scriptIndex }) => {
        const identity = JSON.stringify([
            jobPosting.url || '',
            jobPosting.identifier || '',
            jobPosting.title || '',
            jobPosting.datePosted || ''
        ]);
        if (seen.has(identity)) return [];
        seen.add(identity);

        let canonicalUrl = pageUrl;
        try {
            canonicalUrl = normalizeUrl(jobPosting.url || canonicalHref || pageUrl);
        } catch (_) {
            canonicalUrl = normalizeUrl(pageUrl);
        }

        return [{
            schemaVersion: context.customData.schemaVersion,
            sourceActor: context.customData.sourceActor,
            provider,
            sourceUrl: canonicalUrl,
            scrapedAt: extractedAt,
            pageUrl,
            requestedUrl,
            canonicalUrl,
            crawledAt: extractedAt,
            jobPosting,
            provenance: {
                actor: context.customData.sourceActor,
                provider,
                requestedUrl,
                loadedUrl: pageUrl,
                canonicalUrl,
                discoveredFrom: context.request.userData && context.request.userData.discoveredFrom || null,
                jsonLdScriptIndex: scriptIndex,
                extractedAt
            }
        }];
    });
}`;

export function getJobBoardProvider(urlValue: string): JobBoardProvider {
  const url = parseSupportedBoardUrl(urlValue);
  if (url.hostname === "jobs.lever.co") return "lever";
  if (url.hostname === "jobs.ashbyhq.com") return "ashby";
  return "greenhouse";
}

export function normalizeJobBoardUrl(urlValue: string): string {
  const url = parseSupportedBoardUrl(urlValue);
  url.hash = "";
  return url.href;
}

export function parseJobBoardUrls(values: readonly string[]): string[] {
  const expanded = values.flatMap((value) => value.split(/[\n,]/));
  const normalized = expanded
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeJobBoardUrl);

  return [...new Set(normalized)];
}

export function buildWebScraperInput(
  startUrls: readonly string[],
  options: WebScraperInputOptions = {}
): WebScraperInput {
  const urls = parseJobBoardUrls(startUrls);
  if (urls.length === 0) {
    throw new Error(
      "At least one public Greenhouse, Lever, or Ashby board URL is required. " +
        "Pass URLs as arguments or set JOB_BOARD_URLS."
    );
  }

  return {
    runMode: "PRODUCTION",
    startUrls: urls.map((url) => ({ url })),
    respectRobotsTxtFile: true,
    linkSelector: "",
    globs: [],
    pseudoUrls: [],
    excludes: [
      { glob: "**/*.{png,jpg,jpeg,gif,svg,webp,ico,pdf,zip}" },
      { glob: "**/apply**" }
    ],
    pageFunction: JOB_BOARD_PAGE_FUNCTION,
    injectJQuery: false,
    proxyConfiguration: { useApifyProxy: true },
    maxRequestRetries: 2,
    maxPagesPerCrawl: positiveInteger(options.maxPages, 5_000, "maxPages"),
    maxResultsPerCrawl: positiveInteger(options.maxResults, 5_000, "maxResults"),
    maxCrawlingDepth: 1,
    maxConcurrency: positiveInteger(options.maxConcurrency, 10, "maxConcurrency"),
    pageLoadTimeoutSecs: 60,
    pageFunctionTimeoutSecs: 60,
    waitUntil: ["networkidle2"],
    maxScrollHeightPixels: 20_000,
    downloadMedia: false,
    downloadCss: false,
    customData: {
      sourceActor: OFFICIAL_WEB_SCRAPER_ACTOR_ID,
      schemaVersion: 1,
      maxLinksPerPage: 2_000
    }
  };
}

function parseSupportedBoardUrl(urlValue: string): URL {
  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Invalid job board URL: ${urlValue}`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`Job board URL must use HTTPS: ${urlValue}`);
  }
  if (url.username || url.password) {
    throw new Error(`Job board URL must not contain credentials: ${urlValue}`);
  }
  if (!(SUPPORTED_JOB_BOARD_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) {
    throw new Error(
      `Unsupported job board host "${url.hostname}". ` +
        `Allowed hosts: ${SUPPORTED_JOB_BOARD_HOSTS.join(", ")}.`
    );
  }
  url.hostname = url.hostname.toLowerCase();
  return url;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}
