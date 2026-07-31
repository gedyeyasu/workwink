const APIFY_API = "https://api.apify.com/v2";

/** Starts a configured Apify Actor and returns its run metadata. */
export async function runJobSource({ actorId, input, token = process.env.APIFY_TOKEN, fetchImpl = fetch }) {
  if (!actorId) throw new Error("APIFY_ACTOR_ID is required.");
  if (!token) throw new Error("APIFY_TOKEN is required.");
  const response = await fetchImpl(`${APIFY_API}/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(token)}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input ?? {})
  });
  if (!response.ok) throw new Error(`Apify Actor failed to start (${response.status}).`);
  return response.json();
}

/** Fetches the finished dataset items from a completed Actor run. */
export async function getDatasetItems(datasetId, { token = process.env.APIFY_TOKEN, fetchImpl = fetch } = {}) {
  if (!datasetId || !token) throw new Error("A dataset id and APIFY_TOKEN are required.");
  const response = await fetchImpl(`${APIFY_API}/datasets/${encodeURIComponent(datasetId)}/items?clean=true&token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`Apify dataset failed to load (${response.status}).`);
  return response.json();
}
