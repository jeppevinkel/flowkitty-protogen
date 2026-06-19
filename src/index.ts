import { config } from './config.js';
import { createBot } from './bot.js';

async function main(): Promise<void> {
  const client = createBot();

  // Graceful shutdown so the bot logs out cleanly on Ctrl-C / SIGTERM.
  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down...`);
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await client.login(config.discordToken);
}

main().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});
