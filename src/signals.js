/**
 * Converts a record returned by an Apify Actor into an Elasticsearch-ready
 * observation. The original URL, actor, and collection time remain attached
 * so every agent answer can point back to real-time evidence.
 */
export function normalizeSignal(raw, { actorId, collectedAt = new Date().toISOString() }) {
  if (!raw?.url) throw new Error("A source URL is required for every signal.");
  if (!actorId) throw new Error("An Apify actor id is required for provenance.");

  const text = [raw.title, raw.description, raw.text]
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!text) throw new Error("A signal must include readable source text.");

  return {
    id: raw.id ?? stableId(raw.url, raw.publishedAt ?? collectedAt),
    kind: raw.kind ?? "web-observation",
    neighborhood: raw.neighborhood ?? null,
    title: raw.title ?? "Untitled source",
    text,
    url: raw.url,
    published_at: raw.publishedAt ?? null,
    collected_at: collectedAt,
    source: {
      actor_id: actorId,
      dataset_id: raw.datasetId ?? null,
      publisher: raw.publisher ?? null
    }
  };
}

export const signalIndexMapping = {
  mappings: {
    properties: {
      kind: { type: "keyword" },
      neighborhood: { type: "keyword" },
      title: { type: "text" },
      text: { type: "semantic_text" },
      url: { type: "keyword", index: false },
      published_at: { type: "date" },
      collected_at: { type: "date" },
      source: {
        properties: {
          actor_id: { type: "keyword" },
          dataset_id: { type: "keyword" },
          publisher: { type: "keyword" }
        }
      }
    }
  }
};

function stableId(url, timestamp) {
  let hash = 5381;
  for (const character of `${url}:${timestamp}`) {
    hash = (hash * 33) ^ character.charCodeAt(0);
  }
  return `signal-${(hash >>> 0).toString(36)}`;
}
