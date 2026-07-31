import { signalIndexMapping } from "./signals.js";

export class ElasticJobIndex {
  constructor({ baseUrl = process.env.ELASTICSEARCH_URL, apiKey = process.env.ELASTICSEARCH_API_KEY, index = process.env.ELASTICSEARCH_INDEX ?? "career-crush-jobs", fetchImpl = fetch } = {}) {
    if (!baseUrl) throw new Error("ELASTICSEARCH_URL is required.");
    this.baseUrl = baseUrl.replace(/\/$/, ""); this.apiKey = apiKey; this.index = index; this.fetchImpl = fetchImpl;
  }

  async ensureIndex() { return this.request(`/${this.index}`, { method: "PUT", body: JSON.stringify(signalIndexMapping) }); }
  async indexJob(job) { return this.request(`/${this.index}/_doc/${encodeURIComponent(job.id)}`, { method: "PUT", body: JSON.stringify(job) }); }
  async search(query) { return this.request(`/${this.index}/_search`, { method: "POST", body: JSON.stringify(query) }); }

  async request(path, options) {
    const headers = { "content-type": "application/json", ...(this.apiKey ? { authorization: `ApiKey ${this.apiKey}` } : {}) };
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...options, headers: { ...headers, ...(options.headers ?? {}) } });
    if (!response.ok) throw new Error(`Elasticsearch request failed (${response.status}).`);
    return response.json();
  }
}
