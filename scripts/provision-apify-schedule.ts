import { config, requireApifyConfig } from "../src/config.js";
import { getBoardUrlsFromCliOrEnv, upsertSixHourSchedule, upsertSuccessWebhook } from "../src/integrations/apify.js";

async function main(): Promise<void> {
  const liveConfig = requireApifyConfig();
  const startUrls = getBoardUrlsFromCliOrEnv(
    process.argv.slice(2),
    process.env.JOB_BOARD_URLS
  );
  const result = await upsertSixHourSchedule({
    token: liveConfig.APIFY_TOKEN!,
    startUrls,
    ...(config.APIFY_SCHEDULE_ID ? { scheduleId: config.APIFY_SCHEDULE_ID } : {})
  });
  const webhook = config.APIFY_WEBHOOK_URL && config.APIFY_WEBHOOK_SECRET
    ? await upsertSuccessWebhook({
        token: liveConfig.APIFY_TOKEN,
        requestUrl: config.APIFY_WEBHOOK_URL,
        secret: config.APIFY_WEBHOOK_SECRET
      })
    : null;

  console.log(
    JSON.stringify(
      {
        scheduleId: result.schedule.id,
        name: result.schedule.name,
        created: result.created,
        enabled: result.schedule.isEnabled,
        cronExpression: result.schedule.cronExpression,
        timezone: result.schedule.timezone,
        nextRunAt: result.schedule.nextRunAt,
        webhook: webhook ? {
          webhookId: webhook.webhook.id,
          created: webhook.created,
          requestUrl: webhook.webhook.requestUrl,
          eventTypes: webhook.webhook.eventTypes
        } : { configured: false }
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
