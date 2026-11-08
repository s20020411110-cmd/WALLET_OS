'use strict';

const { GoldMarketWorker } = require('./worker');

async function main() {
  const worker = new GoldMarketWorker();
  process.once('SIGINT', () => worker.stop('SIGINT').finally(() => process.exit(0)));
  process.once('SIGTERM', () => worker.stop('SIGTERM').finally(() => process.exit(0)));
  await worker.start();
  console.log('[gold-worker] running; health endpoint is available on the configured local interface');
}

main().catch(error => {
  console.error('[gold-worker] startup failed:', error.message);
  process.exitCode = 1;
});
