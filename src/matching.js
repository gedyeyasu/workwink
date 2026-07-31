const WEIGHTS = { semantic: 0.42, constraints: 0.25, preference: 0.18, freshness: 0.1, growth: 0.05 };

/** Produces an explainable score for the demo and the eventual Elastic function_score layer. */
export function matchJob(job, profile, swipeSignals = {}) {
  const components = {
    semantic: clamp(job.semanticFit ?? 0.8),
    constraints: clamp(job.constraintFit ?? 0.8),
    preference: clamp((job.preferenceFit ?? 0.78) + (swipeSignals.preferenceLift ?? 0)),
    freshness: clamp(job.freshness ?? 0.9),
    growth: clamp(job.growthFit ?? 0.8)
  };
  const score = Math.round(Object.entries(WEIGHTS).reduce((sum, [key, weight]) => sum + components[key] * weight, 0) * 100);
  return { score, components, reasons: job.reasons ?? [], risks: job.risks ?? [] };
}

export function buildHybridJobQuery(profile, filters = {}) {
  const filter = [];
  if (filters.workStyle && filters.workStyle !== "Any") filter.push({ term: { work_style: filters.workStyle } });
  if (filters.location) filter.push({ term: { location: filters.location } });
  if (filters.minimumCompensation) filter.push({ range: { compensation_max: { gte: filters.minimumCompensation } } });
  return {
    retriever: { rrf: { retrievers: [
      { standard: { query: { bool: { must: [{ semantic: { field: "description", query: profile.resumeText ?? "" } }], filter } } } },
      { knn: { field: "description_embedding", query_vector_builder: { text_embedding: { model_id: "career-crush-embedding", model_text: profile.resumeText ?? "" } }, k: 40, num_candidates: 100 } }
    ] } },
    size: 24,
    sort: [{ _score: "desc" }, { collected_at: "desc" }]
  };
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }
