import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { referencesDir, saving, site, stateDir } from './src/site.ts';
import { sizes } from './src/sizes.ts';

export default defineConfig({
  testDir: 'src',
  outputDir: join(stateDir, 'results'),
  snapshotPathTemplate: join(referencesDir, '{projectName}', '{arg}{ext}'),
  // Only `pnpm stet save-references` writes references. A missing reference fails a comparison.
  updateSnapshots: saving ? 'all' : 'none',
  fullyParallel: true,
  timeout: 120_000,
  reporter: './src/report.ts',
  use: { baseURL: site.baseURL, ignoreHTTPSErrors: true },
  expect: {
    timeout: 30_000,
    // Any changed pixel fails. Raise this only for a specific, reported reason.
    toHaveScreenshot: { threshold: 0 },
  },
  projects: sizes,
});
