import { checkElasticCapabilities, getElasticClient, setupElasticIndices } from "../src/integrations/elastic.js";

const client = getElasticClient();

try {
  const setup = await setupElasticIndices(client);
  const capabilities = await checkElasticCapabilities(client);
  if (!capabilities.ok || !capabilities.jobsIndexReady) {
    throw new Error(capabilities.error ?? "Elasticsearch aliases were not ready after setup.");
  }
  console.log(JSON.stringify({ setup, capabilities }, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.close();
}
