import { config, requireApifyConfig } from "../src/config.js";
import {
  assertOfficialWebScraperActor,
  getBoardUrlsFromCliOrEnv,
  runApifyWebScraper
} from "../src/integrations/apify.js";

async function main(): Promise<void> {
  const liveConfig = requireApifyConfig();
  assertOfficialWebScraperActor(config.APIFY_ACTOR_ID);

  const startUrls = getBoardUrlsFromCliOrEnv(
    process.argv.slice(2),
    process.env.JOB_BOARD_URLS
  );
  const result = await runApifyWebScraper({
    token: liveConfig.APIFY_TOKEN!,
    actorId: liveConfig.APIFY_ACTOR_ID,
    startUrls
  });

  console.log(
    JSON.stringify(
      {
        actorId: liveConfig.APIFY_ACTOR_ID,
        runId: result.runId,
        datasetId: result.datasetId,
        status: result.status,
        itemCount: result.items.length,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        ...(result.usageTotalUsd === undefined
          ? {}
          : { usageTotalUsd: result.usageTotalUsd })
      },
      null,
      2
    )
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
