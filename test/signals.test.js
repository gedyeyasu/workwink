import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSignal, signalIndexMapping } from "../src/signals.js";

test("normalizes a live web record while preserving provenance", () => {
  const signal = normalizeSignal(
    {
      id: "listing-12",
      kind: "rental-listing",
      neighborhood: "East Austin",
      title: "Two-bedroom price reduced",
      description: "Rent dropped to $2,350.",
      url: "https://example.test/listing/12",
      publishedAt: "2026-07-31T12:00:00.000Z",
      datasetId: "dataset-123",
      publisher: "Example Rentals"
    },
    { actorId: "apify/rental-listings", collectedAt: "2026-07-31T15:00:00.000Z" }
  );

  assert.equal(signal.text, "Two-bedroom price reduced\nRent dropped to $2,350.");
  assert.equal(signal.source.actor_id, "apify/rental-listings");
  assert.equal(signal.source.dataset_id, "dataset-123");
  assert.equal(signal.collected_at, "2026-07-31T15:00:00.000Z");
});

test("requires a verifiable source", () => {
  assert.throws(
    () => normalizeSignal({ title: "Unverifiable", text: "No source." }, { actorId: "actor" }),
    /source URL/
  );
});

test("defines semantic text for hybrid retrieval", () => {
  assert.equal(signalIndexMapping.mappings.properties.text.type, "semantic_text");
  assert.equal(signalIndexMapping.mappings.properties.source.properties.actor_id.type, "keyword");
});
