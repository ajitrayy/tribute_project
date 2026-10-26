// Imported first by every test: isolates data in a temp dir and keeps
// credentials out of tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ibn7-test-'));
process.env.DATA_DIR = dir;
process.env.EXTRACTION_PROVIDER = 'manual';
process.env.JOB_BACKOFF_BASE_SEC = '0';
for (const k of ['FB_USER_ACCESS_TOKEN', 'FB_PAGE_ACCESS_TOKENS', 'FB_APP_ID', 'FB_APP_SECRET', 'FB_PPCA_APPROVED', 'ANTHROPIC_API_KEY', 'ADMIN_PASSWORD']) {
  delete process.env[k];
}
export const TEST_DATA_DIR = dir;
