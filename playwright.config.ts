import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { dirs, referencesDir, run } from './src/run.ts';
import { sizes } from './src/sizes.ts';

export default defineConfig({
  testDir: 'src',
  outputDir: join(dirs.state, 'results'),
  snapshotPathTemplate: join(referencesDir, '{projectName}', '{arg}{ext}'),
  // Only `stet save-references` writes references. A missing reference fails a comparison.
  updateSnapshots: run.saving ? 'all' : 'none',
  fullyParallel: true,
  timeout: 120_000,
  reporter: './src/report.ts',
  use: { baseURL: run.baseURL, ignoreHTTPSErrors: true },
  expect: {
    timeout: 30_000,
    // Any changed pixel fails. Raise this only for a specific, reported reason.
    toHaveScreenshot: { threshold: 0 },
  },
  projects: sizes,
});
