import { config, requireApifyConfig } from "../src/config.js";
import { SPONSOR_JOB_BOARD_URLS } from "../src/apify/web-scraper-input.js";
import {
  getBoardUrlsFromCliOrEnv,
  upsertOfficialWebScraperTask
} from "../src/integrations/apify.js";

async function main(): Promise<void> {
  const liveConfig = requireApifyConfig();
  const configuredUrls = getBoardUrlsFromCliOrEnv(
    process.argv.slice(2),
    process.env.JOB_BOARD_URLS
  );
  const startUrls = configuredUrls.length > 0 ? configuredUrls : [...SPONSOR_JOB_BOARD_URLS];

  const result = await upsertOfficialWebScraperTask({
    token: liveConfig.APIFY_TOKEN,
    startUrls,
    ...(config.APIFY_TASK_ID ? { taskId: config.APIFY_TASK_ID } : {})
  });

  // Deliberately print only non-sensitive identifiers and demo metadata.
  console.log(
    JSON.stringify(
      {
        actorId: "apify/web-scraper",
        taskId: result.task.id,
        taskName: result.task.name,
        created: result.created,
        consoleUrl: result.consoleUrl,
        sources: startUrls
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
