import { assertProductionConfig } from './config.js';
import { openDb } from './db.js';
import { startServer } from './server.js';
import { startWorker } from './worker.js';

const mode = process.argv[2] || 'all';
assertProductionConfig();
openDb();

const controller = new AbortController();
let server;
if (mode === 'web' || mode === 'all') server = startServer();
const worker = mode === 'worker' || mode === 'all' ? startWorker({ signal: controller.signal }) : null;

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    controller.abort();
    server?.close();
    await worker;
    process.exit(0);
  });
}
